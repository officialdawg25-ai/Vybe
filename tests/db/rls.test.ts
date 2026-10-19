import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

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
  await db.exec(migration('20261019000001_core_schema.sql'))
  await db.exec(migration('20261019000002_storage.sql'))
  const mk = async (name: string) =>
    (await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
      [`${name}@example.com`, JSON.stringify({ username: name, display_name: name })],
    )).rows[0].id
  ids.a = await mk('alice')
  ids.b = await mk('bob')
  ids.c = await mk('carol')
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
