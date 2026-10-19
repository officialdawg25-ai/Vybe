import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

// SQL_SOURCE=chunks runs the whole suite against supabase/sql-chunks (applied one file at a time, in order).
const CHUNKS = process.env.SQL_SOURCE === 'chunks'
const chunkDir = new URL('../../supabase/sql-chunks/', import.meta.url)
const applySchema = async (db: PGlite) => {
  if (process.env.SQL_FILES) for (const f of process.env.SQL_FILES.split(',')) await db.exec(readFileSync(f, 'utf8'))
  else if (CHUNKS) for (const f of readdirSync(chunkDir).filter(x => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, chunkDir), 'utf8'))
  else for (const f of ['20261019000001_core_schema.sql', '20261019000002_storage.sql', '20261019000003_platform.sql', '20261019000004_brand_hero.sql']) await db.exec(migration(f))
}
const migration = (f: string) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')

const STUBS = `
create role anon nologin; create role authenticated nologin;
create schema auth; create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
alter table storage.objects enable row level security;
grant usage on schema auth, storage, public to anon, authenticated;
grant select on storage.objects to authenticated; grant insert, delete on storage.objects to authenticated;
grant execute on function auth.uid() to anon, authenticated;
`

let db: PGlite
const ids = { a: '', b: '', c: '' }

/** Run SQL as an authenticated user (or anon when uid is null), as PostgREST would. */
async function as<T = any>(uid: string | null, sql: string, params: any[] = []) {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false);`)
  try {
    return (await db.query<T>(sql, params)).rows
  } finally {
    await db.exec('reset role')
  }
}
const fails = async (uid: string | null, sql: string, params: any[] = []) => {
  await expect(as(uid, sql, params)).rejects.toThrow()
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(STUBS)
  await applySchema(db)
  const mk = async (name: string) =>
    (await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
      [`${name}@example.com`, JSON.stringify({ username: name, display_name: name })],
    )).rows[0].id
  ids.a = await mk('alice')
  ids.b = await mk('bob')
  ids.c = await mk('carol')
})

describe('schema application', () => {
  it('is re-runnable: applying everything a second time succeeds and keeps policies working', async () => {
    await applySchema(db)
    expect((await as(ids.a, `select username from public.profiles where id = auth.uid()`))[0].username).toBe('alice')
    expect(await as(ids.c, `select * from public.messages`)).toHaveLength(0)
  })
})

describe('profiles', () => {
  it('are created on signup from metadata', async () => {
    const r = await as(ids.a, `select username from public.profiles where id = auth.uid()`)
    expect(r[0].username).toBe('alice')
  })
  it('falls back to a generated username on collision', async () => {
    const id = (await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ('x@e.com', '{"username":"alice"}') returning id`)).rows[0].id
    const r = await db.query<{ username: string }>(`select username from public.profiles where id = $1`, [id])
    expect(r.rows[0].username).toMatch(/^user_/)
  })
  it('can only be edited by the owner and not re-keyed', async () => {
    await as(ids.a, `update public.profiles set bio = 'hi' where id = auth.uid()`)
    expect(await as(ids.b, `update public.profiles set bio = 'pwned' where id = $1 returning id`, [ids.a])).toHaveLength(0)
    await fails(ids.a, `update public.profiles set username = 'zzz' where id = auth.uid()`) // no column grant
    await fails(ids.a, `insert into public.staff (user_id, role) values (auth.uid(), 'admin')`)
  })
  it('anon cannot read profiles', async () => {
    await fails(null, `select * from public.profiles`)
  })
})

describe('posts & visibility', () => {
  let pub = '', friends = ''
  it('author creates posts', async () => {
    pub = (await as(ids.a, `insert into public.posts (author, body) values (auth.uid(), 'public hello') returning id`))[0].id
    friends = (await as(ids.a, `insert into public.posts (author, body, visibility) values (auth.uid(), 'friends only', 'friends') returning id`))[0].id
  })
  it('cannot post as someone else', async () => {
    await fails(ids.b, `insert into public.posts (author, body) values ($1, 'spoof')`, [ids.a])
  })
  it('friends-only post is hidden from non-friends and shown after acceptance', async () => {
    expect(await as(ids.b, `select id from public.posts where id = $1`, [friends])).toHaveLength(0)
    expect(await as(ids.b, `select id from public.posts where id = $1`, [pub])).toHaveLength(1)
    const f = (await as(ids.b, `insert into public.friendships (requester, addressee) values (auth.uid(), $1) returning id`, [ids.a]))[0].id
    expect(await as(ids.b, `select id from public.posts where id = $1`, [friends])).toHaveLength(0) // still pending
    expect(await as(ids.b, `update public.friendships set status = 'accepted' where id = $1 returning id`, [f])).toHaveLength(0) // requester can't self-accept
    expect(await as(ids.a, `update public.friendships set status = 'accepted' where id = $1 returning id`, [f])).toHaveLength(1)
    expect(await as(ids.b, `select id from public.posts where id = $1`, [friends])).toHaveLength(1)
  })
  it('others cannot edit or delete the post', async () => {
    expect(await as(ids.b, `update public.posts set body = 'x' where id = $1 returning id`, [pub])).toHaveLength(0)
    expect(await as(ids.b, `delete from public.posts where id = $1 returning id`, [pub])).toHaveLength(0)
  })
  it('reaction & comment generate exactly one notification each (deduped)', async () => {
    await as(ids.b, `insert into public.reactions (post_id, user_id) values ($1, auth.uid())`, [pub])
    await as(ids.b, `update public.reactions set kind = 'love' where post_id = $1`, [pub])
    await as(ids.b, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), 'nice')`, [pub])
    const n = await as(ids.a, `select type from public.notifications order by type`)
    expect(n.map(x => x.type)).toEqual(expect.arrayContaining(['reaction', 'comment', 'friend_accepted'].filter(t => t !== 'friend_accepted')))
    expect(n.filter(x => x.type === 'reaction')).toHaveLength(1)
  })
  it('user cannot see or modify others\' notifications, and can only set read_at', async () => {
    expect(await as(ids.b, `select * from public.notifications where user_id = $1`, [ids.a])).toHaveLength(0)
    expect(await as(ids.b, `update public.notifications set read_at = now() where user_id = $1 returning id`, [ids.a])).toHaveLength(0)
    await fails(ids.a, `update public.notifications set user_id = $1`, [ids.b])
    await fails(ids.a, `insert into public.notifications (user_id, type, dedupe_key) values (auth.uid(), 'comment', 'k')`)
    expect(await as(ids.a, `update public.notifications set read_at = now() returning id`)).not.toHaveLength(0)
  })
  it('blocking hides content both ways', async () => {
    await as(ids.a, `insert into public.blocks (blocker, blocked) values (auth.uid(), $1)`, [ids.b])
    expect(await as(ids.b, `select id from public.posts where id = $1`, [pub])).toHaveLength(0)
    expect(await as(ids.b, `select id from public.profiles where id = $1`, [ids.a])).toHaveLength(0)
    await fails(ids.b, `select public.start_dm($1)`, [ids.a])
    await as(ids.a, `delete from public.blocks where blocked = $1`, [ids.b])
  })
  it('save is private', async () => {
    await as(ids.b, `insert into public.saves (post_id, user_id) values ($1, auth.uid())`, [pub])
    expect(await as(ids.a, `select * from public.saves`)).toHaveLength(0)
    expect(await as(ids.b, `select * from public.saves`)).toHaveLength(1)
  })
  it('cannot attach media from another user\'s folder', async () => {
    await fails(ids.b, `insert into public.posts (author, media_path, media_type) values (auth.uid(), $1, 'image')`, [`${ids.a}/x.png`])
  })
})

describe('messaging', () => {
  let conv = ''
  it('DMs require friendship under the default policy', async () => {
    await fails(ids.c, `select public.start_dm($1)`, [ids.a])
    conv = (await as(ids.b, `select public.start_dm($1) as id`, [ids.a]))[0].id // b & a are friends now
    const again = (await as(ids.a, `select public.start_dm($1) as id`, [ids.b]))[0].id
    expect(again).toBe(conv)
  })
  it('members exchange messages; outsiders see nothing and cannot write', async () => {
    await as(ids.b, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'hey')`, [conv])
    expect(await as(ids.a, `select body from public.messages where conversation_id = $1`, [conv])).toHaveLength(1)
    expect(await as(ids.c, `select * from public.messages`)).toHaveLength(0)
    expect(await as(ids.c, `select * from public.conversations`)).toHaveLength(0)
    await fails(ids.c, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'intrude')`, [conv])
    await fails(ids.c, `insert into public.conversation_members (conversation_id, user_id) values ($1, auth.uid())`, [conv])
  })
  it('cannot spoof sender', async () => {
    await fails(ids.b, `insert into public.messages (conversation_id, sender, body) values ($1, $2, 'x')`, [conv, ids.a])
  })
  it('client_id makes sends idempotent', async () => {
    const cid = '11111111-1111-1111-1111-111111111111'
    await as(ids.b, `insert into public.messages (conversation_id, sender, body, client_id) values ($1, auth.uid(), 'once', $2)`, [conv, cid])
    await fails(ids.b, `insert into public.messages (conversation_id, sender, body, client_id) values ($1, auth.uid(), 'once', $2)`, [conv, cid])
  })
  it('message rate limit applies', async () => {
    await fails(ids.b, `do $$ begin for i in 1..70 loop insert into public.messages (conversation_id, sender, body) values ('${conv}', auth.uid(), 'spam'); end loop; end $$`)
  })
})

describe('events', () => {
  let ev = '', priv = ''
  it('host creates public and invite-only events', async () => {
    ev = (await as(ids.a, `insert into public.events (host, title, starts_at, capacity) values (auth.uid(), 'Beach day', now() + interval '1 day', 1) returning id`))[0].id
    priv = (await as(ids.a, `insert into public.events (host, title, starts_at, visibility) values (auth.uid(), 'Secret', now() + interval '2 day', 'invite') returning id`))[0].id
  })
  it('invite-only events are invisible until invited', async () => {
    expect(await as(ids.c, `select id from public.events where id = $1`, [priv])).toHaveLength(0)
    await fails(ids.c, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [priv])
    await fails(ids.c, `insert into public.event_rsvps (event_id, user_id, status) values ($1, $2, 'invited')`, [priv, ids.c]) // non-host
    await as(ids.a, `insert into public.event_rsvps (event_id, user_id, status) values ($1, $2, 'invited')`, [priv, ids.c])
    expect(await as(ids.c, `select id from public.events where id = $1`, [priv])).toHaveLength(1)
    expect((await as(ids.c, `select type from public.notifications where type = 'event_invite'`))).toHaveLength(1)
  })
  it('capacity is enforced', async () => {
    await as(ids.b, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [ev])
    await fails(ids.c, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [ev])
    await as(ids.c, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'maybe')`, [ev])
    await fails(ids.c, `update public.event_rsvps set status = 'going' where event_id = $1`, [ev])
  })
  it('only the host can edit or cancel', async () => {
    expect(await as(ids.b, `update public.events set status = 'cancelled' where id = $1 returning id`, [ev])).toHaveLength(0)
    expect(await as(ids.a, `update public.events set status = 'cancelled' where id = $1 returning id`, [ev])).toHaveLength(1)
  })
})

describe('communities', () => {
  let pubC = '', privC = ''
  it('creator becomes owner', async () => {
    pubC = (await as(ids.a, `insert into public.communities (name, created_by) values ('Runners', auth.uid()) returning id`))[0].id
    privC = (await as(ids.a, `insert into public.communities (name, created_by, visibility) values ('Inner circle', auth.uid(), 'private') returning id`))[0].id
    const r = await as(ids.a, `select role from public.community_members where community_id = $1`, [pubC])
    expect(r[0].role).toBe('owner')
  })
  it('public joins are active, private joins are pending, role self-assignment is rejected', async () => {
    await as(ids.b, `insert into public.community_members (community_id, user_id) values ($1, auth.uid())`, [pubC])
    await fails(ids.c, `insert into public.community_members (community_id, user_id, role) values ($1, auth.uid(), 'admin')`, [pubC])
    await fails(ids.c, `insert into public.community_members (community_id, user_id, status) values ($1, auth.uid(), 'active')`, [privC])
    await as(ids.c, `insert into public.community_members (community_id, user_id, status) values ($1, auth.uid(), 'pending')`, [privC])
  })
  it('pending members cannot post to or read a private community; approval fixes that', async () => {
    const p = (await as(ids.a, `insert into public.posts (author, body, visibility, community_id) values (auth.uid(), 'secret', 'community', $1) returning id`, [privC]))[0].id
    expect(await as(ids.c, `select id from public.posts where id = $1`, [p])).toHaveLength(0)
    await fails(ids.c, `insert into public.posts (author, body, visibility, community_id) values (auth.uid(), 'x', 'community', $1)`, [privC])
    expect(await as(ids.c, `update public.community_members set status = 'active' where user_id = auth.uid() returning user_id`)).toHaveLength(0) // self-approve
    await as(ids.a, `update public.community_members set status = 'active' where community_id = $1 and user_id = $2`, [privC, ids.c])
    expect(await as(ids.c, `select id from public.posts where id = $1`, [p])).toHaveLength(1)
  })
  it('regular members cannot moderate or promote', async () => {
    expect(await as(ids.b, `update public.community_members set role = 'admin' where community_id = $1 and user_id = $2 returning user_id`, [pubC, ids.b])).toHaveLength(0)
    expect(await as(ids.b, `delete from public.community_members where community_id = $1 and user_id = $2 returning user_id`, [pubC, ids.a])).toHaveLength(0)
  })
})

describe('reports, staff and storage', () => {
  it('users report; only staff see all reports; status changes are audited', async () => {
    const r = (await as(ids.b, `insert into public.reports (reporter, entity_type, entity_id, reason) values (auth.uid(), 'profile', $1, 'spam') returning id`, [ids.c]))[0].id
    expect(await as(ids.c, `select * from public.reports`)).toHaveLength(0)
    expect(await as(ids.c, `update public.reports set status = 'dismissed' returning id`)).toHaveLength(0)
    await db.query(`insert into public.staff (user_id, role) values ($1, 'moderator')`, [ids.c])
    expect(await as(ids.c, `update public.reports set status = 'actioned' where id = $1 returning id`, [r])).toHaveLength(1)
    expect(await as(ids.c, `select * from public.audit_log`)).toHaveLength(1)
    expect(await as(ids.b, `select * from public.audit_log`)).toHaveLength(0)
  })
  it('storage: owners write to their own folder only; private objects are not world-readable', async () => {
    await as(ids.a, `insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${ids.a}/a.png`])
    await fails(ids.b, `insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${ids.a}/evil.png`])
    expect(await as(ids.b, `select name from storage.objects`)).toHaveLength(0)
    expect(await as(ids.a, `select name from storage.objects`)).toHaveLength(1)
  })
  it('account deletion cascades', async () => {
    await as(ids.b, `select public.delete_my_account()`)
    expect((await db.query(`select 1 from public.profiles where id = $1`, [ids.b])).rows).toHaveLength(0)
  })
})

describe('platform layer', () => {
  let d = ''
  let org = ''
  it('setup: a fourth user', async () => {
    d = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('dave@example.com', '{"username":"dave"}') returning id`)).rows[0].id
  })

  it('notification preferences suppress opted-out types only', async () => {
    await as(ids.a, `update public.profiles set notif_prefs = '{"comment": false}' where id = auth.uid()`)
    const p = (await as(ids.a, `insert into public.posts (author, body) values (auth.uid(), 'prefs') returning id`))[0].id
    await as(d, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), 'hi')`, [p])
    await as(d, `insert into public.reactions (post_id, user_id) values ($1, auth.uid())`, [p])
    const n = await as(ids.a, `select type from public.notifications where entity_id = $1`, [p])
    expect(n.map(x => x.type)).toEqual(['reaction'])
  })

  it('organizations: creator is owner; unverified; cannot self-verify', async () => {
    org = (await as(ids.a, `insert into public.organizations (name, slug, kind, created_by) values ('Beach Co', 'beach-co', 'organizer', auth.uid()) returning id`))[0].id
    expect((await as(ids.a, `select role, status from public.organization_members where organization_id = $1`, [org]))[0]).toEqual({ role: 'owner', status: 'active' })
    await fails(ids.a, `update public.organizations set verified_at = now() where id = $1`, [org])
    await fails(ids.a, `insert into public.organizations (name, slug, kind, created_by, verified_at) values ('Fake', 'fake-org', 'brand', auth.uid(), now())`)
  })
  it('organization membership is consent-based and role-limited', async () => {
    await fails(d, `insert into public.organization_members (organization_id, user_id, role, status) values ($1, auth.uid(), 'admin', 'active')`, [org]) // self-join
    await fails(ids.a, `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'editor', 'active')`, [org, d]) // skip consent
    await as(ids.a, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'editor')`, [org, d])
    // invited users do not yet have rights
    await fails(d, `insert into public.events (host, title, starts_at, organization_id) values (auth.uid(), 'X', now() + interval '1 day', $1)`, [org])
    await fails(d, `update public.organization_members set status = 'active', role = 'admin' where user_id = auth.uid()`) // role escalation: no column grant
    expect(await as(d, `update public.organization_members set status = 'active' where user_id = auth.uid() returning user_id`)).toHaveLength(1)
    expect((await as(d, `select role from public.organization_members where user_id = auth.uid()`))[0].role).toBe('editor')
  })
  it('active editors can host org events and edit them; outsiders cannot', async () => {
    const e = (await as(d, `insert into public.events (host, title, starts_at, organization_id) values (auth.uid(), 'Org night', now() + interval '1 day', $1) returning id`, [org]))[0].id
    expect(await as(ids.a, `update public.events set title = 'Org night!' where id = $1 returning id`, [e])).toHaveLength(1) // owner via org role
    expect(await as(ids.c, `update public.events set title = 'hijack' where id = $1 returning id`, [e])).toHaveLength(0)
    await fails(ids.c, `insert into public.events (host, title, starts_at, organization_id) values (auth.uid(), 'Y', now() + interval '1 day', $1)`, [org])
  })
  it('org members cannot read other members\' private data via the org', async () => {
    // d is an org editor; a friends-only post by a must stay hidden from d.
    const p = (await as(ids.a, `insert into public.posts (author, body, visibility) values (auth.uid(), 'private', 'friends') returning id`))[0].id
    expect(await as(d, `select id from public.posts where id = $1`, [p])).toHaveLength(0)
  })

  it('subscriptions/provider ledger are not writable or readable by clients', async () => {
    await db.query(`insert into public.plans (id, features) values ('organizer_pro', array['organizer_tools'])`)
    await fails(ids.a, `insert into public.subscriptions (user_id, plan_id, status, provider, provider_ref) values (auth.uid(), 'organizer_pro', 'active', 'x', 'y')`)
    await fails(ids.a, `insert into public.provider_events (provider, event_id) values ('x', '1')`)
    await fails(ids.a, `select * from public.provider_events`)
    await fails(ids.a, `insert into public.plans (id) values ('free')`)
  })
  it('has_feature follows verified server-written subscriptions and org admin rights', async () => {
    expect((await as(ids.a, `select public.has_feature('organizer_tools') as ok`))[0].ok).toBe(false)
    await db.query(`insert into public.subscriptions (organization_id, plan_id, status, provider, provider_ref) values ($1, 'organizer_pro', 'active', 'stripe', 'sub_1')`, [org])
    expect((await as(ids.a, `select public.has_feature('organizer_tools', $1) as ok`, [org]))[0].ok).toBe(true)  // owner
    expect((await as(d, `select public.has_feature('organizer_tools', $1) as ok`, [org]))[0].ok).toBe(false)       // editor
    expect((await as(ids.c, `select public.has_feature('organizer_tools', $1) as ok`, [org]))[0].ok).toBe(false)   // outsider
    expect(await as(ids.c, `select * from public.subscriptions`)).toHaveLength(0)
    expect(await as(ids.a, `select * from public.subscriptions`)).toHaveLength(1)
    await db.query(`update public.subscriptions set status = 'canceled'`)
    expect((await as(ids.a, `select public.has_feature('organizer_tools', $1) as ok`, [org]))[0].ok).toBe(false)
  })

  it('live streams: schedule, visibility, and no client-side going live', async () => {
    const s = (await as(ids.a, `insert into public.live_streams (host, title, scheduled_for) values (auth.uid(), 'Sunset set', now() + interval '1 hour') returning id`))[0].id
    await fails(ids.a, `insert into public.live_streams (host, title, status) values (auth.uid(), 'sneaky', 'live')`)
    await fails(ids.a, `update public.live_streams set status = 'live' where id = $1`, [s])
    await fails(ids.a, `update public.live_streams set room = 'steal' where id = $1`, [s])
    expect(await as(d, `select id from public.live_streams where id = $1`, [s])).toHaveLength(1) // public
    const f = (await as(ids.a, `insert into public.live_streams (host, title, visibility) values (auth.uid(), 'Friends only', 'friends') returning id`))[0].id
    expect(await as(d, `select id from public.live_streams where id = $1`, [f])).toHaveLength(0)
    expect(await as(d, `update public.live_streams set title = 'x' where id = $1 returning id`, [s])).toHaveLength(0)
    expect(await as(ids.a, `update public.live_streams set status = 'cancelled' where id = $1 returning id`, [s])).toHaveLength(1)
  })

  it('staff moderation RPCs: forbidden to users, audited for staff, remove content', async () => {
    const post = (await as(d, `insert into public.posts (author, body) values (auth.uid(), 'bad stuff') returning id`))[0].id
    const rep = (await as(ids.a, `insert into public.reports (reporter, entity_type, entity_id, reason) values (auth.uid(), 'post', $1, 'abusive') returning id`, [post]))[0].id
    await fails(ids.a, `select public.staff_report_context($1)`, [rep])
    await fails(ids.a, `select public.staff_remove_content($1)`, [rep])
    const ctx = (await as(ids.c, `select public.staff_report_context($1) as c`, [rep]))[0].c
    expect(ctx.text).toBe('bad stuff')
    await as(ids.c, `select public.staff_remove_content($1)`, [rep])
    expect((await db.query(`select 1 from public.posts where id = $1`, [post])).rows).toHaveLength(0)
    const actions = (await as(ids.c, `select action from public.audit_log order by id`)).map(r => r.action)
    expect(actions).toEqual(expect.arrayContaining(['report.context_viewed', 'content.removed']))
    expect((await as(ids.a, `select status from public.reports where id = $1`, [rep]))[0].status).toBe('actioned')
  })
})

describe('brand: authentication hero', () => {
  let admin = ''
  const uuid = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
  const img = `hero/${uuid}.jpg`
  const cfg = (extra: object = {}) => JSON.stringify({ media_type: 'image', path: img, focal_x: 30, focal_y: 60, overlay: 40, headline: 'Life is better together.', body: '', ...extra })
  const draft = (uid: string | null, c: string) => as(uid, `select public.save_auth_hero_draft($1::jsonb) as d`, [c])

  it('setup: an admin user', async () => {
    admin = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('erin@example.com', '{"username":"erin"}') returning id`)).rows[0].id
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
  })

  it('signed-out visitors read nothing until something is published', async () => {
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h).toBeNull()
  })
  it('only admins can save, publish, unpublish or reset; moderators and users cannot', async () => {
    for (const who of [null, ids.a, ids.c]) {
      await fails(who, `select public.save_auth_hero_draft($1::jsonb)`, [cfg()])
      await fails(who, `select public.publish_auth_hero()`)
      await fails(who, `select public.unpublish_auth_hero()`)
      await fails(who, `select public.reset_auth_hero()`)
    }
    await fails(ids.a, `insert into public.site_settings (key, published) values ('auth_hero', '{}')`)
    await fails(admin, `update public.site_settings set published = '{}'`) // no direct write grants, even for admins
  })
  it('rejects malformed configuration', async () => {
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ path: '../../etc/passwd' })])
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ path: `hero/${uuid}.exe` })])
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ media_type: 'video' })]) // jpg is not video
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ overlay: 95 })])
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ focal_x: -1 })])
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ headline: 'x'.repeat(121) })])
    await fails(admin, `select public.save_auth_hero_draft($1::jsonb)`, [cfg({ poster_path: `hero/${uuid}.jpg` })]) // poster only for video
  })
  it('a draft is private: not readable by anon or non-admins and not exposed as published', async () => {
    await draft(admin, cfg())
    expect(await as(ids.a, `select * from public.site_settings`)).toHaveLength(0)
    expect(await as(null, `select 1 from public.site_settings`).catch(() => [])).toHaveLength(0)
    expect(await as(admin, `select draft from public.site_settings`)).toHaveLength(1)
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h).toBeNull()
  })
  it('publishing refuses until the media is in the public bucket (previous hero preserved)', async () => {
    await fails(admin, `select public.publish_auth_hero()`)
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h).toBeNull()
  })
  it('publishes once the file is present; signed-out visitors then see only the published copy', async () => {
    await as(admin, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [img])
    await as(admin, `select public.publish_auth_hero()`)
    const h = (await as(null, `select public.get_auth_hero() as h`))[0].h
    expect(h).toMatchObject({ media_type: 'image', path: img, focal_x: 30, overlay: 40, headline: 'Life is better together.' })
    // editing the draft does not change what is published
    await draft(admin, cfg({ headline: 'Draft only' }))
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h.headline).toBe('Life is better together.')
    expect((await db.query(`select 1 from public.audit_log where action = 'auth_hero.published'`)).rows).toHaveLength(1)
  })
  it('a failed replacement leaves the last published hero in place', async () => {
    const other = `hero/${uuid.replace('3f2b', '4a4a')}.jpg`
    await draft(admin, cfg({ path: other }))
    await fails(admin, `select public.publish_auth_hero()`)
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h.path).toBe(img)
  })
  it('unpublish and reset fall back to the default (nothing published)', async () => {
    await as(admin, `select public.unpublish_auth_hero()`)
    expect((await as(null, `select public.get_auth_hero() as h`))[0].h).toBeNull()
    await as(admin, `select public.reset_auth_hero()`)
    expect((await as(admin, `select draft from public.site_settings`))[0].draft).toBeNull()
  })
  it('storage: only admins can upload or read brand buckets; paths are constrained', async () => {
    await fails(ids.a, `insert into storage.objects (bucket_id, name) values ('brand-draft', $1)`, [img])
    await fails(null, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [img])
    await fails(admin, `insert into storage.objects (bucket_id, name) values ('brand-draft', 'hero/evil.html')`)
    await as(admin, `insert into storage.objects (bucket_id, name) values ('brand-draft', $1)`, [img])
    expect(await as(ids.a, `select name from storage.objects where bucket_id = 'brand-draft'`)).toHaveLength(0)
    expect(await as(ids.a, `delete from storage.objects where bucket_id in ('brand', 'brand-draft') returning name`)).toHaveLength(0)
    expect((await db.query(`select public, allowed_mime_types from storage.buckets where id = 'brand-draft'`)).rows[0]).toMatchObject({ public: false })
    expect((await db.query(`select public from storage.buckets where id = 'brand'`)).rows[0]).toMatchObject({ public: true })
  })
})
