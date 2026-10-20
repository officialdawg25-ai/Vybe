import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

// SQL_SOURCE=chunks runs the whole suite against supabase/sql-chunks (applied one file at a time, in order).
const CHUNKS = process.env.SQL_SOURCE === 'chunks'
const chunkDir = new URL('../../supabase/sql-chunks/', import.meta.url)
const applySchema = async (db: PGlite) => {
  if (process.env.SQL_FILES) for (const f of process.env.SQL_FILES.split(',')) await db.exec(readFileSync(f, 'utf8'))
  else if (CHUNKS) for (const f of readdirSync(chunkDir).filter(x => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, chunkDir), 'utf8'))
  else for (const f of ['20261019000001_core_schema.sql', '20261019000002_storage.sql', '20261019000003_platform.sql', '20261019000004_brand_hero.sql', '20261020000005_voice_notes.sql', '20261020000006_events_tickets_location.sql', '20261021000007_live.sql', '20261021000008_finance.sql', '20261022000009_promos.sql']) await db.exec(migration(f))
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

describe('voice notes, onboarding data and organization posts', () => {
  let u = '', v = '', org = ''
  const uid1 = 'aaaa1111-1111-4111-8111-111111111111'
  it('setup', async () => {
    u = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('vera@example.com', '{"username":"vera"}') returning id`)).rows[0].id
    v = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('walt@example.com', '{"username":"walt"}') returning id`)).rows[0].id
  })
  it('a comment can be a voice note: up to ~60 s, stored under the author folder, text optional', async () => {
    const p = (await as(u, `insert into public.posts (author, body) values (auth.uid(), 'hello') returning id`))[0].id
    await as(v, `insert into public.comments (post_id, author, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 59000)`, [p, `${v}/a.webm`])
    await fails(v, `insert into public.comments (post_id, author, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 120000)`, [p, `${v}/a.webm`]) // > 60 s
    await fails(v, `insert into public.comments (post_id, author, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 10000)`, [p, `${u}/a.webm`]) // someone else's folder
    await fails(v, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), '')`, [p])                                             // empty and no audio
    await fails(v, `insert into public.comments (post_id, author, body, audio_path) values ($1, auth.uid(), 'x', $2)`, [p, `${v}/b.webm`])            // path without duration
  })
  it('enforces a minimum age of 13 and sane coordinates', async () => {
    await fails(u, `insert into public.profile_private (user_id, birth_date) values (auth.uid(), (current_date - interval '10 years')::date)`)
    await as(u, `insert into public.profile_private (user_id, birth_date, terms_accepted_at) values (auth.uid(), '1999-05-05', now())`)
    await as(u, `update public.profiles set lat = -26.2, lng = 28.0, country = 'South Africa', intents = '{meet_people,find_events}', onboarding_step = 4 where id = auth.uid()`)
    expect(await as(v, `select * from public.profile_private`)).toHaveLength(0)                       // other people never see birth dates
    expect(await as(u, `select * from public.profile_private`)).toHaveLength(1)
    await fails(v, `insert into public.profile_private (user_id, birth_date) values ($1, '1990-01-01')`, [u])
    await fails(u, `update public.profiles set lat = 120 where id = auth.uid()`)
    await fails(u, `update public.profiles set id = gen_random_uuid() where id = auth.uid()`)
  })
  it('only organization editors can post as the organization, and only publicly', async () => {
    org = (await as(u, `insert into public.organizations (name, slug, kind, created_by) values ('Vera Live', 'vera-live', 'organizer', auth.uid()) returning id`))[0].id
    await as(u, `insert into public.posts (author, body, organization_id) values (auth.uid(), 'From the page', $1)`, [org])
    await fails(v, `insert into public.posts (author, body, organization_id) values (auth.uid(), 'Impersonating', $1)`, [org])
    await fails(u, `insert into public.posts (author, body, organization_id, visibility) values (auth.uid(), 'x', $1, 'friends')`, [org])
  })
})

describe('events near you, lineup and ticketing', () => {
  let host = '', buyer = '', pal = '', rando = '', ev = '', priv = '', ga = '', grp = '', vip = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const order = (uid: string, items: object[], provider = 'payfast', key = crypto.randomUUID()) =>
    as(uid, `select public.create_order($1, $2::jsonb, $3, $4) as o`, [ev, JSON.stringify(items), provider, key]).then(r => r[0].o)

  it('setup: host, buyers and an event in Johannesburg', async () => {
    host = await mk('hosty'); buyer = await mk('buyer'); pal = await mk('palpal'); rando = await mk('rando')
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, city, country, lat, lng, venue, visibility)
      values (auth.uid(), 'Rooftop Sessions', now() + interval '10 days', 'Africa/Johannesburg', 'Johannesburg', 'South Africa', -26.2041, 28.0473, 'The Roof', 'public') returning id`))[0].id
    priv = (await as(host, `insert into public.events (host, title, starts_at, timezone, city, lat, lng, visibility)
      values (auth.uid(), 'Secret one', now() + interval '10 days', 'UTC', 'Johannesburg', -26.2, 28.0, 'invite') returning id`))[0].id
  })
  it('events_near returns public events inside the radius only, sorted by start, and never private ones', async () => {
    const jhb = await as(buyer, `select title from public.events_near(-26.2, 28.04, 30)`)
    expect(jhb.map(r => r.title)).toEqual(['Rooftop Sessions'])
    expect(await as(buyer, `select 1 from public.events_near(-33.92, 18.42, 30)`)).toHaveLength(0)       // Cape Town: ~1,260 km away
    expect(await as(buyer, `select 1 from public.events_near(-26.2, 28.04, 30) where title = 'Secret one'`)).toHaveLength(0)
  })
  it('only the host manages the lineup; everyone who can see the event reads it', async () => {
    await as(host, `insert into public.event_lineup (event_id, name, role, sort) values ($1, 'DJ Nova', 'Headliner', 1)`, [ev])
    await fails(rando, `insert into public.event_lineup (event_id, name) values ($1, 'Fake act')`, [ev])
    expect(await as(buyer, `select name from public.event_lineup where event_id = $1`, [ev])).toHaveLength(1)
    expect(await as(rando, `select name from public.event_lineup where event_id = $1`, [priv])).toHaveLength(0)
  })
  it('only the host can create ticket types, and invalid prices are rejected', async () => {
    ga = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'General', 15000, 3) returning id`, [ev]))[0].id
    grp = (await as(host, `insert into public.ticket_types (event_id, name, kind, group_size, price_cents, quantity_total, max_per_order) values ($1, 'Table for 4', 'group', 4, 50000, 5, 2) returning id`, [ev]))[0].id
    vip = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'Guest list', 0, 100) returning id`, [ev]))[0].id
    await fails(buyer, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'Mine', 100, 10)`, [ev])
    await fails(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'Neg', -5, 10)`, [ev])
    await fails(host, `insert into public.ticket_types (event_id, name, kind, group_size, price_cents, quantity_total) values ($1, 'Odd', 'single', 3, 100, 10)`, [ev])
  })
  it('clients can never insert or edit orders or tickets directly', async () => {
    await fails(buyer, `insert into public.orders (buyer, event_id, subtotal_cents, total_cents, idempotency_key, expires_at) values (auth.uid(), $1, 0, 0, 'abcdefgh', now())`, [ev])
    await fails(buyer, `insert into public.tickets (order_id, event_id, ticket_type_id, owner, code) values (gen_random_uuid(), $1, $2, auth.uid(), 'AAAAAAAAAAAAAAAAAAAA')`, [ev, ga])
    await fails(buyer, `select public.fulfill_order(gen_random_uuid(), 'payfast', 'x', 100)`)
  })
  it('the server computes price and fee; the client cannot influence them', async () => {
    const o = await order(buyer, [{ ticket_type_id: ga, qty: 1 }])
    expect(o).toMatchObject({ status: 'pending', subtotal_cents: 15000, fee_cents: 1050, total_cents: 16050 })    // 5 % of R150 = R7.50 + R3.00
  })
  it('create_order is idempotent per buyer and key', async () => {
    const key = 'idem-key-12345'
    const a = await order(pal, [{ ticket_type_id: ga, qty: 1 }], 'ozow', key)
    const b = await order(pal, [{ ticket_type_id: ga, qty: 1 }], 'ozow', key)
    expect(b.id).toBe(a.id)
    await as(pal, `select public.cancel_my_order($1)`, [a.id])
  })
  it('holds inventory for unpaid orders and reports sold out; cancelling releases the hold', async () => {
    // ga has 3 units; buyer already holds 1 pending. Take 2 more, then the next must fail.
    const o2 = await order(rando, [{ ticket_type_id: ga, qty: 2 }])
    await expect(order(pal, [{ ticket_type_id: ga, qty: 1 }])).rejects.toThrow(/sold out/i)
    await as(rando, `select public.cancel_my_order($1)`, [o2.id])
    await order(pal, [{ ticket_type_id: ga, qty: 1 }])
  })
  it('enforces per-order limits, provider choice, and bad input', async () => {
    await expect(order(buyer, [{ ticket_type_id: grp, qty: 3 }])).rejects.toThrow(/1 to 2/)
    await expect(order(buyer, [{ ticket_type_id: ga, qty: 0 }])).rejects.toThrow()
    await expect(order(buyer, [{ ticket_type_id: ga, qty: 1 }], 'paypal')).rejects.toThrow(/PayFast or Ozow/)
    await expect(order(buyer, [])).rejects.toThrow()
    await expect(order(buyer, [{ ticket_type_id: '00000000-0000-4000-8000-000000000000', qty: 1 }])).rejects.toThrow(/Unknown/)
  })
  it('free tickets are issued immediately and make the holder "going"', async () => {
    const o = await order(rando, [{ ticket_type_id: vip, qty: 1 }])
    expect(o).toMatchObject({ status: 'paid', total_cents: 0 })
    expect(await as(rando, `select code from public.tickets where owner = auth.uid()`)).toHaveLength(1)
    expect(await as(rando, `select status from public.event_rsvps where event_id = $1 and user_id = auth.uid()`, [ev])).toEqual([{ status: 'going' }])
  })
  it('payment fulfilment: amount must match, it is idempotent, and a group unit issues group_size tickets', async () => {
    const o = await order(buyer, [{ ticket_type_id: grp, qty: 1 }], 'ozow')           // R500 + fee R28
    expect(o.total_cents).toBe(50000 + 2500 + 300)
    await expect(db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', 100)`, [o.id])).rejects.toThrow(/amount mismatch/)
    await expect(db.query(`select public.fulfill_order($1, 'payfast', 'tx-1', $2)`, [o.id, o.total_cents])).rejects.toThrow(/provider mismatch/)
    await db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', $2)`, [o.id, o.total_cents])
    await db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', $2)`, [o.id, o.total_cents])  // webhook retry
    const mine = await as(buyer, `select code, status from public.tickets where order_id = $1`, [o.id])
    expect(mine).toHaveLength(4)
    expect(new Set(mine.map(t => t.code)).size).toBe(4)
    expect((await as(buyer, `select status from public.orders where id = $1`, [o.id]))[0].status).toBe('paid')
  })
  it('tickets are private to their owner and the event manager', async () => {
    expect(await as(rando, `select 1 from public.tickets where owner <> auth.uid()`)).toHaveLength(0)
    expect((await as(host, `select 1 from public.tickets`)).length).toBeGreaterThanOrEqual(5)
    expect(await as(rando, `select 1 from public.orders where buyer <> auth.uid()`)).toHaveLength(0)
  })
  it('door check-in is single-use and restricted to the host', async () => {
    const code = (await as(buyer, `select code from public.tickets where owner = auth.uid() limit 1`))[0].code
    expect((await as(rando, `select public.check_in_ticket($1) as r`, [code]))[0].r.result).toBe('forbidden')
    expect((await as(host, `select public.check_in_ticket($1) as r`, [code.toLowerCase()]))[0].r.result).toBe('ok')
    expect((await as(host, `select public.check_in_ticket($1) as r`, [code]))[0].r.result).toBe('used')
    expect((await as(host, `select public.check_in_ticket('NOPE') as r`))[0].r.result).toBe('invalid')
  })
  it('transfers: friends only, once', async () => {
    const t = (await as(buyer, `select id from public.tickets where owner = auth.uid() and status = 'valid' limit 1`))[0].id
    await expect(as(buyer, `select public.transfer_ticket($1, $2)`, [t, pal])).rejects.toThrow(/friends/)
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [buyer, pal])
    await as(buyer, `select public.transfer_ticket($1, $2)`, [t, pal])
    await expect(as(pal, `select public.transfer_ticket($1, $2)`, [t, buyer])).rejects.toThrow(/already been transferred/)
    expect(await as(pal, `select 1 from public.tickets where id = $1`, [t])).toHaveLength(1)
  })
  it('late payments are honoured only while stock remains', async () => {
    const small = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'Last one', 20000, 1) returning id`, [ev]))[0].id
    const o = await order(buyer, [{ ticket_type_id: small, qty: 1 }])
    await db.query(`update public.orders set expires_at = now() - interval '1 minute' where id = $1`, [o.id]); await db.query(`select public.expire_orders()`)
    const o2 = await order(pal, [{ ticket_type_id: small, qty: 1 }])
    await db.query(`select public.fulfill_order($1, 'payfast', 'late-1', $2)`, [o.id, o.total_cents])        // sold out in the meantime
    expect((await db.query<{ status: string }>(`select status from public.orders where id = $1`, [o.id])).rows[0].status).toBe('failed')
    await db.query(`select public.fulfill_order($1, 'payfast', 'ok-1', $2)`, [o2.id, o2.total_cents])
    expect((await db.query<{ status: string }>(`select status from public.orders where id = $1`, [o2.id])).rows[0].status).toBe('paid')
  })
  it('velocity limit stops order spamming', async () => {
    const spammer = await mk('spammy')
    let failed = ''
    for (let i = 0; i < 8 && !failed; i++) {
      try { const o = await order(spammer, [{ ticket_type_id: ga, qty: 1 }]); await as(spammer, `select public.cancel_my_order($1)`, [o.id]) } catch (e) { failed = String(e) }
    }
    expect(failed).toMatch(/sold out|Too many attempts|pending/i)
  })
})

describe('live streaming access (LiveKit token gate)', () => {
  let host = '', fan = '', stranger = '', pal = '', ev = '', open = '', friendsOnly = '', ticketed = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const gate = (uid: string, sid: string, publish = false) => as(uid, `select public.live_token_gate($1, $2) as g`, [sid, publish]).then(r => r[0].g)
  it('setup', async () => {
    host = await mk('livehost'); fan = await mk('livefan'); stranger = await mk('livestranger'); pal = await mk('livepal')
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [host, pal])
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Gig', now() + interval '3 days', 'UTC', 'public') returning id`))[0].id
    open = (await as(host, `insert into public.live_streams (host, title, visibility) values (auth.uid(), 'Open stream', 'public') returning id`))[0].id
    friendsOnly = (await as(host, `insert into public.live_streams (host, title, visibility) values (auth.uid(), 'Friends stream', 'friends') returning id`))[0].id
    ticketed = (await as(host, `insert into public.live_streams (host, event_id, title, visibility, access) values (auth.uid(), $1, 'Ticketed stream', 'public', 'ticket') returning id`, [ev]))[0].id
  })
  it('a ticket-gated stream must belong to an event; only event managers can attach one', async () => {
    await fails(host, `insert into public.live_streams (host, title, access) values (auth.uid(), 'No event', 'ticket')`)
    await fails(stranger, `insert into public.live_streams (host, event_id, title) values (auth.uid(), $1, 'Hijack')`, [ev])
  })
  it('only the host can broadcast; the room name comes back for token minting', async () => {
    expect(await gate(host, open, true)).toMatchObject({ role: 'host', title: 'Open stream' })
    await expect(gate(fan, open, true)).rejects.toThrow(/Only the host/)
    expect((await gate(host, open, true)).room).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('public streams are open to any signed-in viewer; friends-only streams are not', async () => {
    expect(await gate(fan, open)).toMatchObject({ role: 'viewer' })
    await expect(gate(stranger, friendsOnly)).rejects.toThrow(/not available/)
    expect(await gate(pal, friendsOnly)).toMatchObject({ role: 'viewer' })
  })
  it('signed-out callers get nothing', async () => { await expect(as(null, `select public.live_token_gate($1, false)`, [open])).rejects.toThrow() })
  it('blocked and banned viewers are refused; only the host can ban', async () => {
    await as(host, `insert into public.blocks (blocker, blocked) values (auth.uid(), $1)`, [stranger])
    await expect(gate(stranger, open)).rejects.toThrow()
    await expect(as(fan, `select public.ban_from_stream($1, $2)`, [open, pal])).rejects.toThrow(/forbidden/)
    await as(host, `select public.ban_from_stream($1, $2)`, [open, fan])
    await expect(gate(fan, open)).rejects.toThrow(/not available/)
  })
  it('ticket-gated streams need a valid or used ticket (or event management)', async () => {
    await expect(gate(pal, ticketed)).rejects.toThrow(/need a ticket/)
    const tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'Free', 0, 10) returning id`, [ev]))[0].id
    await as(pal, `select public.create_order($1, $2::jsonb, 'payfast', 'live-idem-0001')`, [ev, JSON.stringify([{ ticket_type_id: tt, qty: 1 }])])
    expect(await gate(pal, ticketed)).toMatchObject({ role: 'viewer' })
    expect(await gate(host, ticketed)).toMatchObject({ role: 'viewer' })
  })
  it('token requests are rate limited', async () => {
    const heavy = await mk('livespam')
    let err = ''
    for (let i = 0; i < 25 && !err; i++) { try { await gate(heavy, open) } catch (e) { err = String(e) } }
    expect(err).toMatch(/Too many attempts/)
  })
  it('state changes come only from the webhook function; ended streams cannot be joined', async () => {
    await expect(as(host, `select public.live_apply_event((select room from public.live_streams where id = $1), 'room_started')`, [open])).rejects.toThrow()
    const room = (await db.query<{ room: string }>(`select room from public.live_streams where id = $1`, [open])).rows[0].room
    await db.query(`select public.live_apply_event($1, 'room_started')`, [room])
    expect((await db.query(`select status from public.live_streams where id = $1`, [open])).rows[0]).toEqual({ status: 'live' })
    await db.query(`select public.live_apply_event($1, 'viewers', 42)`, [room]); await db.query(`select public.live_apply_event($1, 'viewers', 10)`, [room])
    expect((await db.query(`select viewers_peak from public.live_streams where id = $1`, [open])).rows[0]).toEqual({ viewers_peak: 42 })
    await as(host, `select public.end_my_stream($1)`, [open])
    await expect(gate(pal, open)).rejects.toThrow(/not available/)
    await expect(as(pal, `select public.end_my_stream($1)`, [friendsOnly])).rejects.toThrow()
  })
})

describe('finance: VAT, receipts, refunds, chargebacks, payouts', () => {
  let host = '', buyer = '', other = '', fadmin = '', ev = '', tt = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const order = (uid: string, qty = 1, key = crypto.randomUUID()) => as(uid, `select public.create_order($1, $2::jsonb, 'payfast', $3) as o`, [ev, JSON.stringify([{ ticket_type_id: tt, qty }]), key]).then(r => r[0].o)
  const pay = (o: { id: string; total_cents: number }, ref = 'pf-' + Math.random()) => db.query(`select public.fulfill_order($1, 'payfast', $2, $3, 'cc')`, [o.id, ref, o.total_cents])
  const ledger = async () => (await db.query<{ kind: string; amount_cents: string }>(`select kind, amount_cents from public.ledger_entries where event_id = $1 or event_id is null order by id`, [ev])).rows.map(r => [r.kind, Number(r.amount_cents)])

  it('setup', async () => {
    host = await mk('fhost'); buyer = await mk('fbuyer'); other = await mk('fother'); fadmin = await mk('fadmin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [fadmin])
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Finance gig', now() + interval '10 days', 'UTC', 'public') returning id`))[0].id
    tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'GA', 20000, 50, 5) returning id`, [ev]))[0].id
  })
  it('a paid order creates the organizer sale entry and a receipt with a sequential number', async () => {
    const o = await order(buyer, 2); await pay(o)
    expect(await ledger()).toEqual([['sale', 40000]])
    const inv = (await as(buyer, `select number, kind, subtotal_cents, fee_cents, fee_vat_cents, total_cents, lines from public.invoices`))[0]
    expect(inv.number).toMatch(/^VYB-\d{4}-\d{6}$/); expect(inv.kind).toBe('receipt'); expect(Number(inv.fee_vat_cents)).toBe(0)
    expect(Number(inv.total_cents)).toBe(Number(inv.subtotal_cents) + Number(inv.fee_cents)); expect(inv.lines[0]).toMatchObject({ name: 'GA', qty: 2, tickets: 2 })
    expect(await as(other, `select 1 from public.invoices`)).toHaveLength(0)
    await pay(o)                                                   // webhook retry: no duplicate ledger row or invoice
    expect(await ledger()).toEqual([['sale', 40000]]); expect((await db.query(`select 1 from public.invoices where order_id = $1`, [o.id])).rows).toHaveLength(1)
  })
  it('when VAT-registered the service fee carries VAT and the document becomes a tax invoice', async () => {
    await db.query(`update public.platform_config set vat_registered = true, vat_number = '4123456789', legal_name = 'VYBE (Pty) Ltd'`)
    const o = await order(other, 1); await pay(o)
    const inv = (await as(other, `select kind, vat_number, legal_name, fee_cents, fee_vat_cents from public.invoices`))[0]
    expect(inv).toMatchObject({ kind: 'tax_invoice', vat_number: '4123456789', legal_name: 'VYBE (Pty) Ltd' })
    expect(Number(inv.fee_vat_cents)).toBe(Math.round(Number(inv.fee_cents) * 1500 / 11500))
    await db.query(`update public.platform_config set vat_registered = false, vat_number = null`)
  })
  it('buyer refunds inside the self-service window are approved at once, then settle through the gateway step', async () => {
    const o = await order(buyer, 1); await pay(o)
    const r = (await as(buyer, `select public.request_refund($1, 'plans changed') as r`, [o.id]))[0].r
    expect(r.status).toBe('approved'); expect(r.ticket_amount_cents).toBe(20000)
    await expect(as(buyer, `select public.request_refund($1, 'again')`, [o.id])).rejects.toThrow()           // one active refund per order
    await expect(as(buyer, `select public.refund_claim($1)`, [r.id])).rejects.toThrow()                        // only the service role claims
    const claimed = (await db.query<{ status: string }>(`select (public.refund_claim($1)).status as status`, [r.id])).rows[0]
    expect(claimed.status).toBe('processing')
    expect((await db.query<{ s: string | null }>(`select (public.refund_claim($1)).status as s`, [r.id])).rows[0].s).toBeNull()   // a second worker gets nothing
    await db.query(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-1')`, [r.id])
    expect((await as(buyer, `select status, refunded_cents from public.orders where id = $1`, [o.id]))[0]).toMatchObject({ status: 'refunded' })
    expect(await as(buyer, `select status from public.tickets where order_id = $1`, [o.id])).toEqual([{ status: 'refunded' }])
    expect((await ledger()).filter(l => l[0] === 'refund')).toEqual([['refund', -20000]])
    await expect(db.query(`update public.ledger_entries set amount_cents = 1`)).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from public.ledger_entries`)).rejects.toThrow(/append-only/)
  })
  it('late requests wait for the organizer; strangers cannot decide; used tickets cannot be refunded', async () => {
    await db.query(`update public.events set starts_at = now() + interval '20 hours' where id = $1`, [ev])
    const o = await order(buyer, 2); await pay(o)
    const r = (await as(buyer, `select public.request_refund($1, 'cannot come') as r`, [o.id]))[0].r
    expect(r.status).toBe('requested')
    await expect(as(other, `select public.decide_refund($1, true)`, [r.id])).rejects.toThrow(/forbidden/)
    await expect(as(buyer, `select public.decide_refund($1, true)`, [r.id])).rejects.toThrow(/forbidden/)
    await as(host, `select public.decide_refund($1, false, 'sorry, too late')`, [r.id])
    expect((await as(buyer, `select status from public.refunds where id = $1`, [r.id]))[0].status).toBe('rejected')
    const code = (await as(buyer, `select code from public.tickets where order_id = $1 limit 1`, [o.id]))[0].code
    await as(host, `select public.check_in_ticket($1)`, [code])
    await expect(as(buyer, `select public.request_refund($1, 'x', (select array_agg(id) from public.tickets where order_id = $1 and status = 'used'))`, [o.id])).rejects.toThrow(/cannot be refunded/)
    const rest = (await as(buyer, `select public.request_refund($1, 'one left') as r`, [o.id]))[0].r              // the unused ticket only
    expect(rest.ticket_amount_cents).toBe(20000)
    await as(host, `select public.decide_refund($1, true)`, [rest.id])
    await db.query(`select public.refund_claim($1)`, [rest.id]); await db.query(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-2')`, [rest.id])
    expect((await as(buyer, `select status from public.orders where id = $1`, [o.id]))[0].status).toBe('partially_refunded')
  })
  it('failed or manual refunds are recorded and can be completed by an admin', async () => {
    await db.query(`update public.events set starts_at = now() + interval '10 days' where id = $1`, [ev])
    const o = await order(other, 1); await pay(o)
    const r = (await as(other, `select public.request_refund($1, 'eft refund') as r`, [o.id]))[0].r
    await db.query(`select public.refund_claim($1)`, [r.id]); await db.query(`select public.refund_finish($1, 'manual_required', 'ozow', null, 'EFT refunds are processed by hand')`, [r.id])
    await expect(as(host, `select public.admin_complete_refund($1, 'BANK123')`, [r.id])).rejects.toThrow(/forbidden/)
    await as(fadmin, `select public.admin_complete_refund($1, 'BANK123')`, [r.id])
    expect((await as(other, `select status, provider, provider_ref from public.refunds where id = $1`, [r.id]))[0]).toEqual({ status: 'succeeded', provider: 'manual', provider_ref: 'BANK123' })
  })
  it('cancelling an event with sales queues a full refund (fee included) for every paid order', async () => {
    const ev2 = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Doomed', now() + interval '10 days', 'UTC', 'public') returning id`))[0].id
    const t2 = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'GA', 10000, 10) returning id`, [ev2]))[0].id
    const o = (await as(buyer, `select public.create_order($1, $2::jsonb, 'ozow', $3) as o`, [ev2, JSON.stringify([{ ticket_type_id: t2, qty: 1 }]), 'doomed-idem-1']))[0].o
    await db.query(`select public.fulfill_order($1, 'ozow', 'oz-1', $2)`, [o.id, o.total_cents])
    await expect(as(other, `select public.cancel_event_with_refunds($1)`, [ev2])).rejects.toThrow(/forbidden/)
    expect((await as(host, `select public.cancel_event_with_refunds($1) as n`, [ev2]))[0].n).toBe(1)
    const r = (await as(buyer, `select kind, status, ticket_amount_cents, fee_amount_cents from public.refunds where order_id = $1`, [o.id]))[0]
    expect(r).toMatchObject({ kind: 'event_cancelled', status: 'approved' }); expect(Number(r.ticket_amount_cents)).toBe(10000); expect(Number(r.fee_amount_cents)).toBe(Number(o.fee_cents))
    await expect(order(other, 1)).resolves.toBeTruthy()          // the other event is unaffected
    expect((await as(buyer, `select status from public.events where id = $1`, [ev2])).length).toBe(1)
  })
  it('chargebacks: opening voids tickets; losing debits the organizer and blocks the buyer; winning restores', async () => {
    const o = await order(other, 1); await pay(o)
    await expect(as(host, `select public.open_dispute($1, 100, 'x')`, [o.id])).rejects.toThrow(/forbidden/)
    const d = (await as(fadmin, `select public.open_dispute($1, $2, 'card dispute') as d`, [o.id, o.total_cents]))[0].d
    expect((await as(other, `select status from public.orders where id = $1`, [o.id]))[0].status).toBe('disputed')
    expect(await as(other, `select status from public.tickets where order_id = $1`, [o.id])).toEqual([{ status: 'void' }])
    await as(fadmin, `select public.resolve_dispute($1, 'won')`, [d])
    expect(await as(other, `select status from public.tickets where order_id = $1`, [o.id])).toEqual([{ status: 'valid' }])
    const o2 = await order(other, 1); await pay(o2)
    const d2 = (await as(fadmin, `select public.open_dispute($1, $2, 'fraud') as d`, [o2.id, o2.total_cents]))[0].d
    await as(fadmin, `select public.resolve_dispute($1, 'lost')`, [d2])
    expect((await ledger()).filter(l => l[0] === 'chargeback')).toEqual([['chargeback', -20000]])
    await expect(order(other, 1)).rejects.toThrow(/disabled for this account/)
    expect(await as(buyer, `select 1 from public.buyer_flags`)).toHaveLength(0)
  })
  it('payouts: balance honours the settlement hold, needs a verified account, and goes through approval', async () => {
    const bal0 = (await as(host, `select public.payout_balance() as b`))[0].b
    expect(bal0.available_cents).toBe(0)                           // event is in the future: nothing is settled yet
    await db.query(`update public.events set starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' where id = $1`, [ev])
    const bal = (await as(host, `select public.payout_balance() as b`))[0].b
    expect(bal.available_cents).toBeGreaterThan(0); expect(bal.available_cents).toBeLessThanOrEqual(bal.balance_cents)
    await expect(as(host, `select public.request_payout()`)).rejects.toThrow(/payout account/)
    const acct = (await db.query<{ id: string }>(`insert into public.payout_accounts (user_id, holder, bank, account_last4, details_enc) values ($1, 'F Host', 'FNB', '1234', 'ciphertext') returning id`, [host])).rows[0].id
    await expect(as(host, `select public.request_payout()`)).rejects.toThrow(/verify/)
    await expect(as(host, `select public.admin_set_payout_account_status($1, 'verified')`, [acct])).rejects.toThrow(/forbidden/)
    await as(fadmin, `select public.admin_set_payout_account_status($1, 'verified')`, [acct])
    const id = (await as(host, `select public.request_payout() as p`))[0].p
    await expect(as(host, `select public.request_payout()`)).rejects.toThrow(/in progress/)
    expect((await as(host, `select public.payout_balance() as b`))[0].b.available_cents).toBe(0)           // requested amount is reserved
    await expect(as(host, `select public.admin_decide_payout($1, true)`, [id])).rejects.toThrow(/forbidden/)
    await expect(as(fadmin, `select public.admin_mark_payout_paid($1, 'EFT1')`, [id])).rejects.toThrow(/approved first/)
    await as(fadmin, `select public.admin_decide_payout($1, true)`, [id]); await as(fadmin, `select public.admin_mark_payout_paid($1, 'EFT1')`, [id])
    expect((await ledger()).filter(l => l[0] === 'payout')).toEqual([['payout', -Number(bal.available_cents)]])
    expect((await as(host, `select public.payout_balance() as b`))[0].b.paid_out_cents).toBe(bal.available_cents)
  })
  it('admins edit platform fees and VAT with validation; everyone else is refused', async () => {
    await expect(as(host, `select public.admin_get_config()`)).rejects.toThrow(/forbidden/)
    await expect(as(host, `select public.admin_set_config('{"fee_bps": 0}'::jsonb)`)).rejects.toThrow(/forbidden/)
    const c = (await as(fadmin, `select public.admin_set_config('{"fee_bps": 450, "vat_registered": true, "vat_number": "4999999999"}'::jsonb) as c`))[0].c
    expect(c).toMatchObject({ fee_bps: 450, vat_registered: true, vat_number: '4999999999', fee_fixed_cents: 300 })
    await expect(as(fadmin, `select public.admin_set_config('{"fee_bps": 99999}'::jsonb)`)).rejects.toThrow()
    await expect(as(fadmin, `select public.admin_set_config('{"vat_registered": true, "vat_number": ""}'::jsonb)`)).rejects.toThrow(/VAT number/)
    await as(fadmin, `select public.admin_set_config('{"fee_bps": 500, "vat_registered": false, "vat_number": ""}'::jsonb)`)
    expect(await as(host, `select 1 from public.platform_config`).catch(() => 'denied')).toBe('denied')
  })
  it('the admin overview aggregates sales, fees, VAT and open work in SQL', async () => {
    await expect(as(host, `select public.admin_finance_summary()`)).rejects.toThrow(/forbidden/)
    const x = (await as(fadmin, `select public.admin_finance_summary() as s`))[0].s
    expect(x.paid_orders).toBeGreaterThan(3); expect(x.ticket_sales_cents).toBeGreaterThan(0); expect(x.service_fees_cents).toBeGreaterThan(0)
    expect(x.open_disputes).toBe(0); expect(x.by_provider).toHaveProperty('payfast')
  })
  it('a refund stuck in processing is released back to the queue', async () => {
    await db.query(`update public.events set starts_at = now() + interval '10 days', ends_at = null where id = $1`, [ev])
    const o = await order(buyer, 1); await pay(o)
    const r = (await as(buyer, `select public.request_refund($1, 'stuck test') as r`, [o.id]))[0].r
    await db.query(`select public.refund_claim($1)`, [r.id]); await db.query(`update public.refunds set decided_at = now() - interval '1 hour' where id = $1`, [r.id])
    expect((await db.query<{ n: number }>(`select public.release_stuck_refunds() as n`)).rows[0].n).toBeGreaterThanOrEqual(1)
    expect((await as(buyer, `select status from public.refunds where id = $1`, [r.id]))[0].status).toBe('approved')
  })
  it('finance data is private: others cannot read it, and encrypted bank details never leave the database', async () => {
    expect(await as(other, `select 1 from public.ledger_entries`)).toHaveLength(0)
    expect(await as(other, `select 1 from public.payouts`)).toHaveLength(0)
    expect(await as(other, `select 1 from public.payout_accounts`)).toHaveLength(0)
    expect((await as(host, `select holder, account_last4 from public.payout_accounts`))[0]).toEqual({ holder: 'F Host', account_last4: '1234' })
    await expect(as(host, `select details_enc from public.payout_accounts`)).rejects.toThrow()
    await expect(as(host, `insert into public.payout_accounts (user_id, holder, bank, account_last4, details_enc) values (auth.uid(), 'x', 'y', '1', 'z')`)).rejects.toThrow()
    await expect(as(other, `select public.payout_balance(null) as b where false`)).resolves.toBeDefined()
    expect((await as(fadmin, `select count(*) as n from public.ledger_entries`))[0].n).not.toBe('0')
    await expect(as(host, `select public.admin_add_adjustment(null, auth.uid(), 5000, 'free money')`)).rejects.toThrow(/forbidden/)
  })
})

describe('home billboard: promo slides and trending events', () => {
  let admin = '', member = '', host = '', fan = '', far = '', hot = '', quiet = '', farEv = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const slide = (extra = '') => `insert into public.promo_slides (title, cta_url, status ${extra ? ',' + extra.split('|')[0] : ''}) values ('Sponsored gig', '/app/discover', 'live' ${extra ? ',' + extra.split('|')[1] : ''}) returning id`
  it('setup', async () => {
    admin = await mk('promoadmin'); member = await mk('promomember'); host = await mk('promohost'); fan = await mk('promofan'); far = await mk('promofar')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
  })
  it('only admins create, edit or delete slides; members only see live, in-window slides', async () => {
    await expect(as(member, slide())).rejects.toThrow()
    const live = (await as(admin, slide()))[0].id
    const draft = (await as(admin, `insert into public.promo_slides (title, cta_url) values ('Draft', 'https://example.com/x') returning id`))[0].id
    const future = (await as(admin, `insert into public.promo_slides (title, cta_url, status, starts_at) values ('Later', '/app/plans', 'live', now() + interval '2 days') returning id`))[0].id
    const expired = (await as(admin, `insert into public.promo_slides (title, cta_url, status, starts_at, ends_at) values ('Over', '/app/plans', 'live', now() - interval '3 days', now() - interval '1 day') returning id`))[0].id
    expect((await as(member, `select id from public.promo_slides`)).map(r => r.id)).toEqual([live])
    expect((await as(admin, `select id from public.promo_slides`)).length).toBe(4)
    expect(await as(member, `update public.promo_slides set title = 'hacked' where id = $1 returning id`, [live])).toHaveLength(0)
    expect(await as(member, `delete from public.promo_slides where id = $1 returning id`, [live])).toHaveLength(0)
    await as(admin, `update public.promo_slides set status = 'paused' where id = $1`, [live])
    expect(await as(member, `select id from public.promo_slides`)).toHaveLength(0)
    void draft; void future; void expired
  })
  it('rejects unsafe links, bad media paths and bad windows', async () => {
    for (const bad of ["'javascript:alert(1)'", "'http://insecure.example'", "'//evil.example'", "'/etc/passwd'", "'data:text/html,x'"]) await fails(admin, `insert into public.promo_slides (title, cta_url) values ('x1', ${bad})`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, media_type, media_path) values ('Media', '/app/plans', 'image', '../../x.jpg')`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, media_type) values ('Media', '/app/plans', 'image')`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, starts_at, ends_at) values ('Win', '/app/plans', now(), now() - interval '1 day')`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, accent) values ('Colour', '/app/plans', 'red')`)
    await as(admin, `insert into public.promo_slides (title, cta_url) values ('Fine', 'https://partner.example.com/offer?x=1')`)
  })
  it('counts one impression and one click per member per day; stats are admin-only; rate limited', async () => {
    const s = (await as(admin, `select id from public.promo_slides where title = 'Sponsored gig'`))[0].id
    await as(admin, `update public.promo_slides set status = 'live' where id = $1`, [s])
    expect((await as(member, `select public.promo_track($1, 'impression') as t`, [s]))[0].t).toBe(true)
    expect((await as(member, `select public.promo_track($1, 'impression') as t`, [s]))[0].t).toBe(false)     // same day, same member
    expect((await as(fan, `select public.promo_track($1, 'impression') as t`, [s]))[0].t).toBe(true)
    expect((await as(member, `select public.promo_track($1, 'click') as t`, [s]))[0].t).toBe(true)
    expect((await as(member, `select public.promo_track($1, 'click') as t`, [s]))[0].t).toBe(false)           // click-spam does not inflate
    await expect(as(member, `select public.promo_track($1, 'purchase')`, [s])).rejects.toThrow()
    expect((await as(null, `select 1`).then(() => 1))).toBe(1)
    await expect(as(null, `select public.promo_track($1, 'click')`, [s])).rejects.toThrow()
    expect((await as(admin, `select impressions, clicks from public.promo_stats where slide_id = $1`, [s]))[0]).toEqual({ impressions: 2, clicks: 1 })
    expect(await as(member, `select 1 from public.promo_stats`)).toHaveLength(0)
    expect(await as(member, `select 1 from public.promo_seen`).catch(() => 'denied')).toBe('denied')
  })
  it('behaviour settings: members read merged defaults; only admins change them (and values are clamped)', async () => {
    expect((await as(member, `select public.home_hero_settings() as s`))[0].s).toMatchObject({ trending_enabled: true, max_trending: 5, autoplay_ms: 7000 })
    await expect(as(member, `select public.save_home_hero_settings('{"max_trending": 9}'::jsonb)`)).rejects.toThrow(/forbidden/)
    const v = (await as(admin, `select public.save_home_hero_settings('{"max_trending": 99, "autoplay_ms": 100, "trending_enabled": false}'::jsonb) as v`))[0].v
    expect(v).toMatchObject({ max_trending: 10, autoplay_ms: 3000, trending_enabled: false })
    expect((await as(member, `select public.home_hero_settings() as s`))[0].s).toMatchObject({ trending_enabled: false })
  })
  it('trending: real activity ranks first, quiet plans pad the list, far or private events never appear', async () => {
    hot = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, lat, lng, city) values (auth.uid(), 'Hot night', now() + interval '5 days', 'UTC', 'public', -26.2, 28.04, 'Johannesburg') returning id`))[0].id
    quiet = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, lat, lng, city) values (auth.uid(), 'Quiet brunch', now() + interval '3 days', 'UTC', 'public', -26.15, 28.0, 'Johannesburg') returning id`))[0].id
    farEv = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, lat, lng, city) values (auth.uid(), 'Cape gig', now() + interval '2 days', 'UTC', 'public', -33.92, 18.42, 'Cape Town') returning id`))[0].id
    await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, lat, lng) values (auth.uid(), 'Secret', now() + interval '2 days', 'UTC', 'invite', -26.2, 28.04)`)
    const tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'GA', 15000, 20) returning id`, [hot]))[0].id
    const o = (await as(fan, `select public.create_order($1, $2::jsonb, 'payfast', 'trend-idem-01') as o`, [hot, JSON.stringify([{ ticket_type_id: tt, qty: 2 }])]))[0].o
    await db.query(`select public.fulfill_order($1, 'payfast', 'tr-1', $2)`, [o.id, o.total_cents])
    const list = (await as(member, `select public.trending_events(-26.2, 28.04, 60, 8) as t`))[0].t as { id: string; title: string; trending: boolean; score: number; going: number; price_from_cents: number }[]
    const mine = list.filter(x => x.title === 'Hot night' || x.title === 'Quiet brunch')
    expect(mine.map(x => x.title)).toEqual(['Hot night', 'Quiet brunch'])
    expect(list.findIndex(x => x.title === 'Hot night')).toBeLessThan(list.findIndex(x => x.title === 'Quiet brunch'))
    expect(mine[0]).toMatchObject({ trending: true, going: 1, price_from_cents: 15000 }); expect(mine[1].trending).toBe(false)
    expect(list.some(x => x.title === 'Secret' || x.title === 'Cape gig')).toBe(false)
    expect(((await as(member, `select public.trending_events(-33.92, 18.42, 60, 8) as t`))[0].t as { title: string }[]).map(x => x.title)).toContain('Cape gig')
    expect(((await as(host, `select public.trending_events(-26.2, 28.04, 60, 8) as t`))[0].t as { id: string }[]).some(x => [hot, quiet, farEv].includes(x.id))).toBe(false)    // your own events are not promoted to you
    await expect(as(null, `select public.trending_events()`)).rejects.toThrow()
    void far
  })
  it('promo media can only be uploaded by admins, under promo/ with a uuid name', async () => {
    const u = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
    await as(admin, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/${u}.mp4`])
    await fails(member, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/${u}.png`])
    await fails(admin, `insert into storage.objects (bucket_id, name) values ('brand', 'promo/evil.html')`)
    await fails(admin, `insert into storage.objects (bucket_id, name) values ('brand', 'other/${u}.png')`)
  })
})
