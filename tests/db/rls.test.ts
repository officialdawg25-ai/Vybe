import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

// SQL_SOURCE=chunks runs the whole suite against supabase/sql-chunks (applied one file at a time, in order).
const CHUNKS = process.env.SQL_SOURCE === 'chunks'
const chunkDir = new URL('../../supabase/sql-chunks/', import.meta.url)
const applySchema = async (db: PGlite) => {
  if (process.env.SQL_FILES) for (const f of process.env.SQL_FILES.split(',')) await db.exec(readFileSync(f, 'utf8'))
  else if (CHUNKS) for (const f of readdirSync(chunkDir).filter(x => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, chunkDir), 'utf8'))
  else for (const f of ['20261019000001_core_schema.sql', '20261019000002_storage.sql', '20261019000003_platform.sql', '20261019000004_brand_hero.sql', '20261020000005_voice_notes.sql', '20261020000006_events_tickets_location.sql', '20261021000007_live.sql', '20261021000008_finance.sql', '20261022000009_promos.sql', '20261023000010_discover.sql', '20261024000011_social_profiles.sql', '20261025000012_chat_calls_voice.sql', '20261026000013_e2ee_chat.sql', '20261027000014_chat_security_groups.sql', '20261028000015_posts_names.sql', '20261029000016_campaigns.sql', '20261030000017_profile_privacy.sql', '20261031000018_media_policy_anon_helpers.sql', '20261101000019_org_portal.sql', '20261102000020_org_communities_notifications_media.sql', '20261103000021_advisor_fixes.sql', '20261104000022_reels_live_usernames_music.sql', '20261105000023_event_media_discover_tiles.sql', '20261106000024_live_guests.sql', '20261107000025_media_speed_field_metrics.sql', '20261108000026_story_music_reel_studio.sql', '20261109000027_feed_suggestions.sql', '20261110000028_tickets_trust_ledger.sql', '20261111000029_tickets_risk_reviews_referrals.sql', '20261112000030_tickets_commission_email_fees.sql', '20261113000031_pg_net_schema.sql', '20261114000032_post_song_start_comment_likes.sql', '20261115000033_ticket_branding_host_trust.sql', '20261116000034_post_publishing_rules.sql', '20261117000035_video_smaller_copy.sql', '20261118000036_sponsored_posts.sql', '20261119000037_rotating_ticket_qr.sql', '20261120000038_profile_motion_avatar.sql']) await db.exec(migration(f))
}
const migration = (f: string) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8')

const STUBS = `
create role anon nologin; create role authenticated nologin;
create schema auth; create schema storage;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
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
  // Suites written before migration 28 sell tickets for events nobody reviewed and pay out right after adding bank
  // details. They test other rules, so the review gate and the cooling-off period are off for them; the migration 28
  // suite turns both back on and tests them directly.
  await db.exec(`update public.platform_config set require_sales_review = false, payout_account_cooloff_hours = 0`)
  // Suites written before migration 34 attach media paths without uploading a file first. Simulate the upload for them
  // (a storage row appears for any new path); the migration 34 suite drops this and tests the real rule.
  await db.exec(`create or replace function public.test_simulate_upload() returns trigger language plpgsql as $f$
      begin
        if tg_table_name = 'posts' then
          if new.media_path is not null then insert into storage.objects (bucket_id, name) select 'media', new.media_path where not exists (select 1 from storage.objects where bucket_id = 'media' and name = new.media_path); end if;
        else
          insert into storage.objects (bucket_id, name) select 'media', new.path where not exists (select 1 from storage.objects where bucket_id = 'media' and name = new.path);
          if new.display_path is not null then insert into storage.objects (bucket_id, name, metadata) select 'media', new.display_path, jsonb_build_object('mimetype', case when new.display_path ~ '[.](webm|mp4|mov)$' then 'video/' else 'image/' end || 'x') where not exists (select 1 from storage.objects where bucket_id = 'media' and name = new.display_path); end if;
        end if;
        return new;
      end $f$;
    create trigger aa_test_simulate_upload before insert or update of media_path on public.posts for each row execute function public.test_simulate_upload();
    create trigger aa_test_simulate_upload before insert on public.post_media for each row execute function public.test_simulate_upload();`)
  // Suites written before migration 30 price under the v1 launch terms (buyer fee); the migration 30 suite switches to v2.
  await db.exec(`alter table public.fee_policies disable trigger fee_policy_immutable;
    update public.fee_policies set retired_at = null where name = 'Platform v1 (launch terms)';
    update public.fee_policies set retired_at = effective_from where name = 'Platform v2 (organiser commission)';
    alter table public.fee_policies enable trigger fee_policy_immutable;`)
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
    expect(await as(ids.c, `select * from public.audit_log where entity_type <> 'fee_policy'`)).toHaveLength(1)   // migration 29 records its terms change too
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
    await fails(v, `insert into public.comments (post_id, author, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 100000000)`, [p, `${v}/a.webm`]) // beyond the 24 h sanity bound
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
    expect(await as(rando, `select public.my_ticket_code(id) as code from public.tickets where owner = auth.uid()`)).toHaveLength(1)
    expect(await as(rando, `select status from public.event_rsvps where event_id = $1 and user_id = auth.uid()`, [ev])).toEqual([{ status: 'going' }])
  })
  it('payment fulfilment: amount must match, it is idempotent, and a group unit issues group_size tickets', async () => {
    const o = await order(buyer, [{ ticket_type_id: grp, qty: 1 }], 'ozow')           // R500 + fee R28
    expect(o.total_cents).toBe(50000 + 2500 + 300)
    await expect(db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', 100)`, [o.id])).rejects.toThrow(/amount mismatch/)
    await expect(db.query(`select public.fulfill_order($1, 'payfast', 'tx-1', $2)`, [o.id, o.total_cents])).rejects.toThrow(/provider mismatch/)
    await db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', $2)`, [o.id, o.total_cents])
    await db.query(`select public.fulfill_order($1, 'ozow', 'tx-1', $2)`, [o.id, o.total_cents])  // webhook retry
    const mine = await as(buyer, `select public.my_ticket_code(id) as code, status from public.tickets where order_id = $1`, [o.id])
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
    const code = (await as(buyer, `select public.my_ticket_code(id) as code from public.tickets where owner = auth.uid() limit 1`))[0].code
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
    const code = (await as(buyer, `select public.my_ticket_code(id) as code from public.tickets where order_id = $1 limit 1`, [o.id]))[0].code
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
  it('admins edit VAT and holds with validation; fees moved to versioned policies (migration 28); everyone else is refused', async () => {
    await expect(as(host, `select public.admin_get_config()`)).rejects.toThrow(/forbidden/)
    await expect(as(host, `select public.admin_set_config('{"vat_registered": false}'::jsonb)`)).rejects.toThrow(/forbidden/)
    await expect(as(fadmin, `select public.admin_set_config('{"fee_bps": 450}'::jsonb)`)).rejects.toThrow(/fee policies/)
    const c = (await as(fadmin, `select public.admin_set_config('{"vat_registered": true, "vat_number": "4999999999"}'::jsonb) as c`))[0].c
    expect(c).toMatchObject({ vat_registered: true, vat_number: '4999999999' })
    await expect(as(fadmin, `select public.admin_set_config('{"vat_rate_bps": 99999}'::jsonb)`)).rejects.toThrow()
    await expect(as(fadmin, `select public.admin_set_config('{"vat_registered": true, "vat_number": ""}'::jsonb)`)).rejects.toThrow(/VAT number/)
    await as(fadmin, `select public.admin_set_config('{"vat_registered": false, "vat_number": ""}'::jsonb)`)
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

describe('discover: categories, drafts, follows, attendance privacy, notifications, discovery RPCs', () => {
  let admin = '', host = '', fan = '', friend = '', stranger = '', blocked = '', org = '', pub = '', draft = '', stream = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const notes = async (uid: string, type?: string) => (await as(uid, `select type, entity_id from public.notifications ${type ? `where type = '${type}'` : ''}`))
  const ev = (title: string, extra = '', cols = '') => `insert into public.events (host, title, starts_at, timezone, visibility, lat, lng, city ${cols}) values (auth.uid(), '${title}', now() + interval '6 days', 'UTC', 'public', -26.2, 28.04, 'Johannesburg' ${extra}) returning id`

  it('setup', async () => {
    admin = await mk('dscadmin'); host = await mk('dschost'); fan = await mk('dscfan'); friend = await mk('dscfriend'); stranger = await mk('dscstranger'); blocked = await mk('dscblocked')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted'), ($3, $2, 'accepted')`, [fan, friend, host])
    await db.query(`insert into public.blocks (blocker, blocked) values ($1, $2)`, [host, blocked])
    org = (await as(host, `insert into public.organizations (name, slug, kind, created_by) values ('Local Band', 'local-band', 'artist', auth.uid()) returning id`))[0].id
    await db.query(`insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'owner', 'active') on conflict do nothing`, [org, host])
  })

  it('categories are readable by members and editable only by admins', async () => {
    expect((await as(fan, `select slug from public.event_categories where group_key = 'concerts' order by sort`)).map(r => r.slug)).toContain('concerts')
    await fails(fan, `insert into public.event_categories (slug, label) values ('mine', 'Mine')`)
    await as(admin, `insert into public.event_categories (slug, label, group_key) values ('jazz-nights', 'Jazz nights', 'concerts')`)
    await as(admin, `update public.event_categories set active = false where slug = 'jazz-nights'`)
    await fails(host, `update public.events set category = 'nope' where false`).catch(() => {})
  })

  it('drafts are invisible to everyone but their owner/editors; publishing makes them discoverable', async () => {
    draft = (await as(host, ev('Secret rehearsal', ", 'concerts'", ', category').replace("returning id", "returning id")))[0].id
    await as(host, `update public.events set status = 'draft' where id = $1`, [draft])
    expect(await as(fan, `select 1 from public.events where id = $1`, [draft])).toHaveLength(0)
    expect(await as(host, `select 1 from public.events where id = $1`, [draft])).toHaveLength(1)
    expect(((await as(fan, `select public.discover_events(null, null, null, null, null, now() - interval '1 day') as d`))[0].d as { id: string }[]).some(x => x.id === draft)).toBe(false)
    expect((await as(fan, `select public.event_social($1) as s`, [draft]))[0].s).toBeNull()
  })

  it('online events need a link once published; external listings cannot be created from a browser', async () => {
    await fails(host, ev('Online gig', ", 'online'", ', format').replace("lat, lng, city", "lat, lng, city"))
    await as(host, `insert into public.events (host, title, starts_at, timezone, format, online_url, status) values (auth.uid(), 'Stream gig', now() + interval '3 days', 'UTC', 'online', 'https://example.com/live', 'active')`)
    await fails(host, `insert into public.events (host, title, starts_at, timezone, source, source_name, source_url) values (auth.uid(), 'Fake external', now() + interval '3 days', 'UTC', 'external', 'Provider', 'https://example.com')`)
    await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)   // trusted server code has no member identity
    await db.query(`insert into public.events (host, title, starts_at, timezone, source, source_name, source_url) values ($1, 'Provider gig', now() + interval '4 days', 'UTC', 'external', 'Provider', 'https://example.com/x')`, [host])
  })

  it('follows: own rows only, no duplicates, no self-follow, no following across a block', async () => {
    await as(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    await fails(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    await as(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [host])
    await fails(fan, `insert into public.follows (follower, target_type, target_id) values ($1, 'organization', $2)`, [stranger, org])
    await fails(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', auth.uid())`)
    await fails(blocked, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [host])
    await fails(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', gen_random_uuid())`)
    expect(await as(stranger, `select 1 from public.follows`)).toHaveLength(0)
    expect(await as(stranger, `delete from public.follows returning 1`)).toHaveLength(0)
    expect((await as(stranger, `select public.follow_stats('organization', $1) as s`, [org]))[0].s).toEqual({ followers: 1, following: false })
    await as(friend, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    await as(stranger, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    await as(stranger, `delete from public.follows where follower = auth.uid()`)
  })

  it('publishing notifies followers once, honours preferences, skips the host and blocked members', async () => {
    await as(friend, `update public.profiles set notif_prefs = '{"new_event": false}'::jsonb where id = auth.uid()`)
    pub = (await as(host, ev('Big gig', `, '${org}', 'concerts'`, ', organization_id, category')))[0].id
    expect((await notes(fan, 'new_event')).map(n => n.entity_id)).toEqual([pub])
    expect(await notes(friend, 'new_event')).toHaveLength(0)                  // opted out
    expect(await notes(host, 'new_event')).toHaveLength(0)
    expect(await notes(stranger, 'new_event')).toHaveLength(0)                // unfollowed
    await as(host, `update public.events set title = 'Big gig!' where id = $1`, [pub])           // a title edit is not a publication
    await as(host, `update public.events set status = 'draft' where id = $1`, [pub])
    await as(host, `update public.events set status = 'active' where id = $1`, [pub])            // re-publish: dedupe key stops a second ping
    expect(await notes(fan, 'new_event')).toHaveLength(1)
    await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, status) values (auth.uid(), 'Private draft', now() + interval '2 days', 'UTC', 'public', 'draft')`)
    expect(await notes(fan, 'new_event')).toHaveLength(1)                     // drafts never notify
    await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Invite only', now() + interval '2 days', 'UTC', 'invite')`)
    expect(await notes(fan, 'new_event')).toHaveLength(1)                     // non-public never fans out
  })

  it('attendance: Interested, Going and Saved are distinct; visibility is enforced per person', async () => {
    await as(fan, `insert into public.event_rsvps (event_id, user_id, status, visibility) values ($1, auth.uid(), 'going', 'friends')`, [pub])
    await as(stranger, `insert into public.event_rsvps (event_id, user_id, status, visibility) values ($1, auth.uid(), 'maybe', 'public')`, [pub])
    await as(blocked, `insert into public.event_rsvps (event_id, user_id, status, visibility) values ($1, auth.uid(), 'going', 'public')`, [pub]).catch(() => {})
    await as(friend, `insert into public.event_saves (user_id, event_id) values (auth.uid(), $1)`, [pub])
    await fails(friend, `insert into public.event_saves (user_id, event_id) values ($1, $2)`, [fan, pub])
    // friend sees fan (friends-only) and stranger (public); stranger sees only public ones; nobody gets private rows
    const people = (uid: string) => as(uid, `select public.event_social($1) as s`, [pub]).then(r => (r[0].s as { people: { id: string; status: string }[] }).people.map(p => p.id).sort())
    expect(await people(friend)).toEqual([fan, stranger].sort())
    expect(await people(stranger)).toEqual([])                               // fan is friends-only and stranger is not their friend
    await as(fan, `update public.event_rsvps set visibility = 'private' where event_id = $1 and user_id = auth.uid()`, [pub])
    expect(await people(friend)).toEqual([stranger])
    expect(await as(friend, `select user_id from public.event_rsvps where event_id = $1 and user_id = $2`, [pub, fan])).toHaveLength(0)
    expect(await as(host, `select user_id from public.event_rsvps where event_id = $1 and user_id = $2`, [pub, fan])).toHaveLength(1)   // organisers see their attendees
    const s = (await as(friend, `select public.event_social($1) as s`, [pub]))[0].s as { going: number; interested: number; saved: boolean }
    expect(s).toMatchObject({ going: 1, interested: 1, saved: true })       // counts are true aggregates; saved is separate
    await fails(fan, `update public.event_rsvps set user_id = $1 where event_id = $2`, [friend, pub])
  })

  it('discover_events filters, respects privacy, and never lists drafts, private or other people\'s hidden attendance', async () => {
    const q = async (uid: string, args: string) => ((await as(uid, `select public.discover_events(${args}) as d`))[0].d as { id: string; title: string; friends_going: number; followed: boolean; category: string; price_from_cents: number | null; org: { name: string } | null }[])
    const all = await q(fan, `null, null, null, null, null, now()`)
    const titles = all.map(x => x.title)
    expect(titles).toContain('Big gig!'); expect(titles).not.toContain('Private draft'); expect(titles).not.toContain('Invite only')
    expect((await q(fan, `null, 'concerts', null, null, null, now()`)).every(x => x.category)).toBe(true)
    expect((await q(fan, `'local band', null, null, null, null, now()`)).map(x => x.title)).toContain('Big gig!')               // finds by organisation name
    expect((await q(fan, `null, null, null, 'online', null, now()`)).map(x => x.title)).toEqual(expect.arrayContaining(['Stream gig']))
    expect((await q(fan, `null, null, null, null, null, now(), null, -33.9, 18.4, 30`)).map(x => x.title)).not.toContain('Big gig!')   // Cape Town: nothing close
    expect((await q(fan, `null, null, null, null, null, now(), null, -26.2, 28.04, 30`)).map(x => x.title)).toContain('Big gig!')
    expect((await q(fan, `null, null, null, null, null, now(), null, null, null, null, true`)).every(x => x.followed)).toBe(true)
    expect((await q(stranger, `null, null, null, null, null, now(), null, null, null, null, true`))).toHaveLength(0)           // follows nobody now
    expect((await q(friend, `null, null, null, null, null, now(), null, null, null, null, false, false, true`)).map(x => x.title)).toEqual(['Big gig!'])   // saved
    const withFriends = await q(friend, `null, null, null, null, null, now(), null, null, null, null, false, true`)
    expect(withFriends.map(x => x.title)).toEqual([])                         // fan's attendance is private now → no "friend going" signal leaks
    await as(fan, `update public.event_rsvps set visibility = 'friends' where event_id = $1 and user_id = auth.uid()`, [pub])
    expect((await q(friend, `null, null, null, null, null, now(), null, null, null, null, false, true`)).map(x => x.title)).toEqual(['Big gig!'])
    expect((await q(blocked, `null, null, null, null, null, now()`)).map(x => x.title)).not.toContain('Big gig!')              // blocked by the host
    expect((await q(fan, `null, null, null, null, null, now(), null, null, null, null, false, false, false, 'soonest', 1000`)).length).toBeLessThanOrEqual(40)   // page size is capped
    await expect(as(null, `select public.discover_events()`)).rejects.toThrow()
  })

  it('cancelling or materially changing an event notifies attendees once; trivial edits do not', async () => {
    await as(host, `update public.events set description = 'new blurb' where id = $1`, [pub])
    expect(await notes(fan, 'event_update')).toHaveLength(0)
    await as(host, `update public.events set venue = 'The Roof' where id = $1`, [pub])
    await as(host, `update public.events set venue = 'The Roof', description = 'again' where id = $1`, [pub])
    expect(await notes(fan, 'event_update')).toHaveLength(1)
    expect(await notes(stranger, 'event_update')).toHaveLength(1)             // "interested" attendees are told too
    expect(await notes(friend, 'event_update')).toHaveLength(0)               // only saved it: not an attendee
    await as(host, `update public.events set status = 'cancelled' where id = $1`, [pub])
    await as(host, `update public.events set status = 'cancelled' where id = $1`, [pub])
    expect(await notes(fan, 'event_cancelled')).toHaveLength(1)
    expect(((await as(fan, `select public.discover_events(null, null, null, null, null, now()) as d`))[0].d as { id: string }[]).some(x => x.id === pub)).toBe(false)
  })

  it('discover_orgs ranks by upcoming activity (not popularity) and respects followed filter', async () => {
    const q = async (uid: string, args: string) => ((await as(uid, `select public.discover_orgs(${args}) as d`))[0].d as { id: string; name: string; kind: string; followers: number; upcoming: number; following: boolean }[])
    expect((await q(fan, `array['artist']`)).map(o => o.name)).toContain('Local Band')
    expect((await q(fan, `array['venue']`)).map(o => o.name)).not.toContain('Local Band')
    expect((await q(fan, `null, 'local'`))[0]).toMatchObject({ followers: 2, following: true })
    expect(await q(stranger, `null, null, true`)).toHaveLength(0)
  })

  it('event-related live: only event-linked, visible streams appear; scheduled is never labelled live; going live notifies once', async () => {
    const e2 = (await as(host, ev('Streamed show', `, '${org}', 'concerts'`, ', organization_id, category')))[0].id
    stream = (await as(host, `insert into public.live_streams (host, event_id, organization_id, title, scheduled_for) values (auth.uid(), $1, $2, 'Streamed show live', now() + interval '1 hour') returning id`, [e2, org]))[0].id
    await as(host, `insert into public.live_streams (host, title) values (auth.uid(), 'Just chatting')`)
    const list = async (uid: string) => (await as(uid, `select public.discover_live() as d`))[0].d as { id: string; status: string; title: string }[]
    const l = await list(fan)
    expect(l.map(x => x.title)).toContain('Streamed show live')
    expect(l.map(x => x.title)).not.toContain('Just chatting')               // the individual stream stays on Home
    expect(l.find(x => x.title === 'Streamed show live')!.status).toBe('scheduled')
    await as(fan, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [e2])
    const room = (await db.query<{ room: string }>(`select room from public.live_streams where id = $1`, [stream])).rows[0].room
    await db.query(`select public.live_apply_event($1, 'room_started')`, [room])
    await db.query(`select public.live_apply_event($1, 'room_started')`, [room])
    expect((await list(fan)).find(x => x.title === 'Streamed show live')!.status).toBe('live')
    expect(await notes(fan, 'live_started')).toHaveLength(1)
    expect(await notes(host, 'live_started')).toHaveLength(0)
    expect((await list(blocked)).map(x => x.title)).not.toContain('Streamed show live')
  })

  it('maps gate rate-limits per member and nobody can read the usage log', async () => {
    for (let i = 0; i < 40; i++) await as(fan, `select public.maps_gate('autocomplete')`)
    await expect(as(fan, `select public.maps_gate('autocomplete')`)).rejects.toThrow(/Too many/)
    await as(friend, `select public.maps_gate('route')`)
    await fails(fan, `select * from public.maps_usage_log`)
    await expect(as(null, `select public.maps_gate('x')`)).rejects.toThrow()
  })
})

describe('social: post extras, tags, memories, music, profile details, verification', () => {
  let alice = '', bob = '', carol = '', dave = '', admin = '', post1 = '', mem = '', track = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const notes = async (uid: string, type: string) => (await as(uid, `select entity_id from public.notifications where type = '${type}'`))

  it('setup', async () => {
    alice = await mk('socalice'); bob = await mk('socbob'); carol = await mk('soccarol'); dave = await mk('socdave'); admin = await mk('socadmin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [alice, bob])
    await db.query(`insert into public.blocks (blocker, blocked) values ($1, $2)`, [alice, dave])
  })

  it('posts carry feeling, place, song and a gallery; constraints reject nonsense', async () => {
    post1 = (await as(alice, `insert into public.posts (author, body, visibility, feeling, place_name, place_lat, place_lng, music_title, music_artist, media_path, media_type) values (auth.uid(), 'Night out', 'friends', 'happy', 'Rooftop, Cape Town', -33.92, 18.42, 'Zange', 'Bongeziwe', $1, 'image') returning id`, [`${alice}/a.jpg`]))[0].id
    await fails(alice, `insert into public.posts (author, body, feeling) values (auth.uid(), 'x', 'HAPPY!!')`)
    await fails(alice, `insert into public.posts (author, body, place_lat, place_lng) values (auth.uid(), 'x', 1, 1)`)                       // coordinates need a name
    await fails(alice, `insert into public.posts (author, body, music_title, music_artist, music_url) values (auth.uid(), 'x', 't', 'a', 'http://insecure.example')`)
    await as(alice, `insert into public.post_media (post_id, sort, path, type) values ($1, 0, $2, 'image'), ($1, 1, $3, 'video')`, [post1, `${alice}/a.jpg`, `${alice}/b.mp4`])
    await fails(alice, `insert into public.post_media (post_id, sort, path, type) values ($1, 2, $2, 'image')`, [post1, `${bob}/steal.jpg`])         // only your own folder
    await fails(bob, `insert into public.post_media (post_id, sort, path, type) values ($1, 2, $2, 'image')`, [post1, `${bob}/x.jpg`])                // not your post
    expect(await as(bob, `select 1 from public.post_media where post_id = $1`, [post1])).toHaveLength(2)                                              // friend sees it
    expect(await as(carol, `select 1 from public.post_media where post_id = $1`, [post1])).toHaveLength(0)                                            // friends-only post: gallery hidden too
    expect(await as(dave, `select 1 from public.post_media where post_id = $1`, [post1])).toHaveLength(0)
  })

  it('tags: friends only, up to 10, the tagged person can remove, one notification each', async () => {
    await fails(alice, `insert into public.post_tags (post_id, user_id) values ($1, $2)`, [post1, carol])                                          // not a friend
    await fails(alice, `insert into public.post_tags (post_id, user_id) values ($1, auth.uid())`, [post1])
    await fails(bob, `insert into public.post_tags (post_id, user_id) values ($1, $2)`, [post1, alice])                                              // not the author
    await as(alice, `insert into public.post_tags (post_id, user_id) values ($1, $2)`, [post1, bob])
    await fails(alice, `insert into public.post_tags (post_id, user_id) values ($1, $2)`, [post1, bob])
    expect(await notes(bob, 'post_tag')).toHaveLength(1)
    expect(await as(carol, `select 1 from public.post_tags`)).toHaveLength(0)
    expect(await as(bob, `delete from public.post_tags where post_id = $1 returning 1`, [post1])).toHaveLength(1)
    expect(await as(carol, `delete from public.post_tags returning 1`)).toHaveLength(0)
  })

  it('music catalogue: admins curate, members browse/save, trending counts real use, inactive tracks hidden', async () => {
    const u = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
    track = (await as(admin, `insert into public.music_tracks (title, artist, artwork_path, preview_path, external_url) values ('Zange', 'Bongeziwe', 'music/${u}.jpg', 'music/${u}.mp3', 'https://example.com/zange') returning id`))[0].id
    await fails(carol, `insert into public.music_tracks (title, artist) values ('x', 'y')`)
    await fails(admin, `insert into public.music_tracks (title, artist, preview_path) values ('x', 'y', '../evil.mp3')`)
    await fails(admin, `insert into public.music_tracks (title, artist, external_url) values ('x', 'y', 'http://insecure.example')`)
    const cat = async (uid: string, tab: string, q = 'null') => ((await as(uid, `select public.music_catalog('${tab}', ${q}) as c`))[0].c as { id: string; title: string; saved: boolean }[])
    expect((await cat(carol, 'foryou')).map(t => t.title)).toContain('Zange')
    expect(await cat(carol, 'saved')).toHaveLength(0)
    await as(carol, `insert into public.saved_tracks (user_id, track_id) values (auth.uid(), $1)`, [track])
    await fails(carol, `insert into public.saved_tracks (user_id, track_id) values ($1, $2)`, [alice, track])
    expect((await cat(carol, 'saved')).map(t => t.title)).toEqual(['Zange'])
    expect(await as(alice, `select 1 from public.saved_tracks`)).toHaveLength(0)
    await as(alice, `insert into public.posts (author, body, music_track_id, music_title, music_artist) values (auth.uid(), 'Listening', $1, 'Zange', 'Bongeziwe')`, [track])
    expect((await cat(carol, 'trending'))[0].id).toBe(track)
    expect((await cat(carol, 'foryou', `'zang'`)).map(t => t.title)).toEqual(['Zange'])
    await as(admin, `update public.music_tracks set active = false where id = $1`, [track])
    expect((await cat(carol, 'foryou')).map(t => t.id)).not.toContain(track)
    expect(await as(carol, `select 1 from public.music_tracks where id = $1`, [track])).toHaveLength(0)
  })

  it('memories: visibility, expiry, blocks, highlights, rail and viewer', async () => {
    mem = (await as(alice, `insert into public.memories (author, kind, text_body, bg, visibility) values (auth.uid(), 'text', 'Golden hour', 'rose', 'friends') returning id`))[0].id
    const pubMem = (await as(alice, `insert into public.memories (author, kind, media_path, text_body, visibility) values (auth.uid(), 'photo', $1, 'Beach', 'public') returning id`, [`${alice}/m.jpg`]))[0].id
    await fails(alice, `insert into public.memories (author, kind, text_body) values (auth.uid(), 'text', '   ')`)                                    // empty text card
    await fails(alice, `insert into public.memories (author, kind, media_path) values (auth.uid(), 'photo', $1)`, [`${bob}/steal.jpg`])             // someone else's folder
    await fails(alice, `insert into public.memories (author, kind) values (auth.uid(), 'photo')`)
    await fails(bob, `insert into public.memories (author, kind, text_body) values ($1, 'text', 'as alice')`, [alice])
    await fails(alice, `update public.memories set expires_at = now() + interval '30 days' where id = $1`, [mem])                                      // cannot extend the 24h life
    const ids = async (uid: string) => (await as(uid, `select id from public.memories where author = $1`, [alice])).map(r => r.id).sort()
    expect(await ids(bob)).toEqual([mem, pubMem].sort())                                                                                                // friend sees both
    expect(await ids(carol)).toEqual([pubMem])                                                                                                          // stranger sees only public
    expect(await ids(dave)).toEqual([])                                                                                                                 // blocked sees nothing
    const rail = async (uid: string) => ((await as(uid, `select public.memory_rail() as r`))[0].r as { author: { id: string; username: string }; count: number; unseen: number; friend: boolean; cover: { kind: string } }[])
    expect((await rail(bob)).find(x => x.author.id === alice)).toMatchObject({ count: 2, unseen: 2, friend: true })
    expect((await rail(carol)).find(x => x.author.id === alice)).toMatchObject({ count: 1, friend: false })
    expect((await rail(dave)).some(x => x.author.id === alice)).toBe(false)
    expect((await rail(alice)).some(x => x.author.id === alice)).toBe(false)                                                                            // your own are not in your rail
    const viewer = async (uid: string) => ((await as(uid, `select public.author_memories($1) as m`, [alice]))[0].m as { id: string; views: number | null }[])
    expect((await viewer(bob)).map(m => m.id)).toEqual([mem, pubMem])
    expect((await viewer(bob))[0].views).toBeNull()                                                                                                     // counts are for the owner only
    await as(bob, `insert into public.memory_views (memory_id, viewer) values ($1, auth.uid())`, [mem])
    await fails(carol, `insert into public.memory_views (memory_id, viewer) values ($1, auth.uid())`, [mem])                                            // cannot "view" what you cannot see
    await fails(bob, `insert into public.memory_views (memory_id, viewer) values ($1, $2)`, [pubMem, carol])
    expect((await rail(bob)).find(x => x.author.id === alice)!.unseen).toBe(1)
    expect((await viewer(alice))[0].views).toBe(1)
    expect(await as(carol, `select 1 from public.memory_views`)).toHaveLength(0)
    expect(await as(alice, `select 1 from public.memory_views`)).toHaveLength(1)                                                                        // the owner sees who watched
    // expiry and highlights
    await asServer(`update public.memories set expires_at = now() - interval '1 hour' where id = $1`, [mem])
    expect(await ids(bob)).toEqual([pubMem]); expect(await ids(alice)).toEqual([mem, pubMem].sort())                                                    // owner keeps an archive
    expect((await viewer(bob)).map(m => m.id)).toEqual([pubMem])
    await as(alice, `update public.memories set highlight = true, highlight_title = 'Summer' where id = $1`, [mem])
    expect(await ids(bob)).toEqual([mem, pubMem].sort())                                                                                                // highlighted memories stay visible
    expect(((await as(bob, `select public.author_memories($1, true) as m`, [alice]))[0].m as unknown[])).toHaveLength(1)
    expect(await as(bob, `update public.memories set highlight = false where id = $1 returning 1`, [mem])).toHaveLength(0)
  })

  it('memory reactions and replies: only the owner and the sender can read them; replies respect who may message the owner', async () => {
    const live = (await as(alice, `insert into public.memories (author, kind, text_body, visibility) values (auth.uid(), 'text', 'Live one', 'public') returning id`))[0].id
    await as(bob, `insert into public.memory_reactions (memory_id, user_id, emoji) values ($1, auth.uid(), 'heart')`, [live])
    await fails(bob, `insert into public.memory_reactions (memory_id, user_id, emoji) values ($1, auth.uid(), 'heart')`, [live])                           // one reaction each
    await fails(carol, `insert into public.memory_reactions (memory_id, user_id, emoji) values ($1, auth.uid(), 'poop')`, [live])
    await as(bob, `update public.memory_reactions set emoji = 'fire' where memory_id = $1 and user_id = auth.uid()`, [live])
    expect(await notes(alice, 'memory_reaction')).toHaveLength(1)
    expect(await as(carol, `select 1 from public.memory_reactions`)).toHaveLength(0)
    expect((await as(alice, `select emoji from public.memory_reactions where memory_id = $1`, [live]))[0].emoji).toBe('fire')
    await fails(dave, `insert into public.memory_reactions (memory_id, user_id, emoji) values ($1, auth.uid(), 'like')`, [live])                         // blocked
    // alice allows messages from friends only → carol (stranger) cannot reply, bob (friend) can
    await fails(carol, `insert into public.memory_replies (memory_id, author, body) values ($1, auth.uid(), 'hi')`, [live])
    await as(bob, `insert into public.memory_replies (memory_id, author, body) values ($1, auth.uid(), 'Love this')`, [live])
    await as(bob, `insert into public.memory_replies (memory_id, author, audio_path, audio_ms) values ($1, auth.uid(), $2, 4200)`, [live, `${bob}/v.webm`])
    await fails(bob, `insert into public.memory_replies (memory_id, author, audio_path, audio_ms) values ($1, auth.uid(), $2, 4200)`, [live, `${alice}/v.webm`])
    await fails(bob, `insert into public.memory_replies (memory_id, author, body) values ($1, auth.uid(), '')`, [live])
    await fails(bob, `insert into public.memory_replies (memory_id, author, audio_path, audio_ms) values ($1, auth.uid(), $2, 100000000)`, [live, `${bob}/long.webm`])   // beyond the 24 h sanity bound
    expect(await as(alice, `select 1 from public.memory_replies where memory_id = $1`, [live])).toHaveLength(2)
    expect(await as(bob, `select 1 from public.memory_replies where memory_id = $1`, [live])).toHaveLength(2)
    expect(await as(carol, `select 1 from public.memory_replies`)).toHaveLength(0)
    await as(alice, `update public.profiles set dm_policy = 'everyone' where id = auth.uid()`)
    await as(carol, `insert into public.memory_replies (memory_id, author, body) values ($1, auth.uid(), 'Open door')`, [live])
    expect(await notes(alice, 'memory_reply')).toHaveLength(3)
    const files = ['reply.webm', 'm.jpg']
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2)`, [`${bob}/v.webm`, `${alice}/m.jpg`])
    expect(await as(carol, `select 1 from storage.objects where name = $1`, [`${bob}/v.webm`])).toHaveLength(0)       // a reply's audio is not public
    expect(await as(alice, `select 1 from storage.objects where name = $1`, [`${bob}/v.webm`])).toHaveLength(1)       // but the memory owner can play it
    expect(await as(carol, `select 1 from storage.objects where name = $1`, [`${alice}/m.jpg`])).toHaveLength(1)      // public memory media is readable
    expect(await as(dave, `select 1 from storage.objects where name = $1`, [`${alice}/m.jpg`])).toHaveLength(0)       // blocked: not readable
    void files
  })

  it('profile details: owner-only table; others read through get_profile_details by section visibility; View as; validation', async () => {
    await as(alice, `insert into public.profile_details (user_id, about, current_city, relationship, gender, hobbies, travel, links, contact, birthday_visible, visibility)
      values (auth.uid(), 'Hello', 'Cape Town', 'single', 'female', array['Surfing'], array['Zanzibar'], '[{"label":"Site","url":"https://example.com"}]'::jsonb, '{"social":"@alice","phone":"0820000000"}'::jsonb, true,
      '{"about":"public","personal":"friends","work":"public","education":"public","hobbies":"public","travel":"me","links":"public","contact":"friends"}'::jsonb)`)
    await as(alice, `insert into public.profile_private (user_id, birth_date) values (auth.uid(), '2000-05-17') on conflict (user_id) do update set birth_date = excluded.birth_date`)
    expect(await as(bob, `select 1 from public.profile_details`)).toHaveLength(0)
    await fails(bob, `update public.profile_details set about = 'hacked' where user_id = $1`, [alice]).catch(() => {})
    const get = async (uid: string, as_: string | null = null) => (await as(uid, `select public.get_profile_details($1, $2) as d`, [alice, as_]))[0].d as Record<string, any> | null
    const friend = await get(bob), stranger = await get(carol), me = await get(alice), pub = await get(alice, 'public'), blocked = await get(dave)
    expect(friend).toMatchObject({ level: 2, about: 'Hello', hobbies: ['Surfing'], contact: { social: '@alice' }, personal: { current_city: 'Cape Town', birthday: '17 May' } })
    expect(friend!.travel).toBeUndefined()                                                  // "only me"
    expect(friend!.personal.gender).toBeNull()                                              // gender is never shown to others
    expect(stranger).toMatchObject({ level: 1, about: 'Hello' }); expect(stranger!.personal).toBeUndefined(); expect(stranger!.contact).toBeUndefined(); expect(stranger!.travel).toBeUndefined()
    expect(me).toMatchObject({ level: 3, travel: ['Zanzibar'], personal: { gender: 'female' } })
    expect(pub!.contact).toBeUndefined(); expect(pub!.travel).toBeUndefined(); expect(pub!.personal).toBeUndefined()   // View as public hides friends-only parts
    expect(blocked).toBeNull()
    await fails(carol, `select public.get_profile_details($1, 'friend')`, [alice]).catch(() => {})
    expect((await as(carol, `select public.get_profile_details($1, 'friend') as d`, [alice]))[0].d).toMatchObject({ level: 1 })   // only the owner can preview
    await fails(alice, `update public.profile_details set links = '[{"label":"x","url":"javascript:alert(1)"}]'::jsonb where user_id = auth.uid()`)
    await fails(alice, `update public.profile_details set links = '[{"label":"x","url":"http://insecure.example"}]'::jsonb where user_id = auth.uid()`)
    await fails(alice, `update public.profile_details set visibility = '{"about":"everyone"}'::jsonb where user_id = auth.uid()`)
    await fails(alice, `update public.profile_details set education = '[{"school":""}]'::jsonb where user_id = auth.uid()`)
    await fails(alice, `update public.profile_details set relationship = 'it is complicated' where user_id = auth.uid()`)
  })

  it('follow settings and counts respect the owner’s choices', async () => {
    await as(alice, `update public.profiles set follow_policy = 'friends', show_followers = 'friends' where id = auth.uid()`)
    await fails(carol, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [alice])
    await as(bob, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [alice])
    const stats = async (uid: string) => (await as(uid, `select public.profile_stats($1) as s`, [alice]))[0].s as Record<string, any> | null
    expect(await stats(bob)).toMatchObject({ friends: 1, followers: 1, i_follow: true })
    expect(await stats(carol)).toMatchObject({ friends: 1, followers: null, following: null, i_follow: false })
    expect(await stats(dave)).toBeNull()
    await as(alice, `update public.profiles set follow_policy = 'everyone', show_followers = 'public' where id = auth.uid()`)
    await as(carol, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [alice])
    expect((await stats(carol))!.followers).toBe(2)
    await fails(alice, `update public.profiles set verified_until = now() + interval '1 year' where id = auth.uid()`)   // nobody can grant themselves the badge
  })

  it('VYBE Verified: server-priced orders, idempotent, paid only by the payment webhook, extends rather than resets, admin override', async () => {
    expect((await as(carol, `select id from public.verification_plans order by sort`)).map(r => r.id)).toEqual(['monthly', 'yearly'])
    expect(await as(carol, `update public.verification_plans set price_cents = 100 where id = 'monthly' returning 1`)).toHaveLength(0)       // only admins change prices
    await expect(as(carol, `select public.create_badge_order('monthly', 'payfast', 'idem-badge-01')`)).rejects.toThrow(/profile photo/)    // needs a photo and a name first
    await asServer(`update public.profiles set avatar_path = $1 where id = $2`, [`${alice}/avatar.webp`, alice])
    const o = (await as(alice, `select public.create_badge_order('monthly', 'payfast', 'idem-badge-01') as o`))[0].o as { id: string; total_cents: number; status: string }
    expect(o).toMatchObject({ status: 'pending', total_cents: 4900 })
    expect((await as(alice, `select public.create_badge_order('yearly', 'ozow', 'idem-badge-01') as o`))[0].o.id).toBe(o.id)               // same key, same order (no double charge)
    await expect(as(alice, `select public.create_badge_order('free-forever', 'payfast', 'idem-badge-02')`)).rejects.toThrow()
    await expect(as(alice, `select public.create_badge_order('monthly', 'bitcoin', 'idem-badge-03')`)).rejects.toThrow()
    await fails(alice, `insert into public.badge_orders (buyer, plan_id, days, total_cents, provider, idempotency_key, expires_at) values (auth.uid(), 'monthly', 30, 100, 'payfast', 'cheat-0001', now())`)
    await fails(alice, `update public.badge_orders set status = 'paid' where id = $1`, [o.id])
    await expect(as(alice, `select public.fulfill_badge_order($1, 'payfast', 'x', 4900)`, [o.id])).rejects.toThrow()                       // members cannot call it
    expect(await as(carol, `select 1 from public.badge_orders`)).toHaveLength(0)
    await expect(asServer(`select public.fulfill_badge_order($1, 'payfast', 'pf-1', 100)`, [o.id])).rejects.toThrow(/Amount mismatch/)
    await expect(asServer(`select public.fulfill_badge_order($1, 'ozow', 'pf-1', 4900)`, [o.id])).rejects.toThrow(/Provider mismatch/)
    await asServer(`select public.fulfill_badge_order($1, 'payfast', 'pf-1', 4900)`, [o.id])
    const first = (await asServer(`select verified_until from public.profiles where id = $1`, [alice]))[0].verified_until as Date
    expect(first.getTime()).toBeGreaterThan(Date.now() + 29 * 864e5); expect(first.getTime()).toBeLessThan(Date.now() + 31 * 864e5)
    await asServer(`select public.fulfill_badge_order($1, 'payfast', 'pf-1', 4900)`, [o.id])                                              // webhook retry: no double extension
    expect(((await asServer(`select verified_until from public.profiles where id = $1`, [alice]))[0].verified_until as Date).getTime()).toBe(first.getTime())
    expect(await notes(alice, 'verified')).toHaveLength(1)
    const o2 = (await as(alice, `select public.create_badge_order('monthly', 'ozow', 'idem-badge-04') as o`))[0].o.id
    await asServer(`select public.fulfill_badge_order($1, 'ozow', 'oz-1', 4900)`, [o2])
    const second = (await asServer(`select verified_until from public.profiles where id = $1`, [alice]))[0].verified_until as Date
    expect(second.getTime() - first.getTime()).toBe(30 * 864e5)                                                                            // renewal adds time on top
    expect(await as(carol, `select verified_until from public.profiles where id = $1`, [alice])).toHaveLength(1)                           // the badge is public information
    await expect(as(carol, `select public.admin_set_verified($1, now() + interval '1 day')`, [carol])).rejects.toThrow(/forbidden/)
    await as(admin, `select public.admin_set_verified($1, null)`, [alice])
    expect((await asServer(`select verified_until from public.profiles where id = $1`, [alice]))[0].verified_until).toBeNull()             // admin can revoke
    await asServer(`select public.close_badge_order($1, 'cancelled')`, [o2])
    expect((await asServer(`select status from public.badge_orders where id = $1`, [o2]))[0].status).toBe('paid')                          // a paid order is never closed
  })
})

describe('people discovery, mutual followers, message attachments', () => {
  let a = '', b = '', c = '', d = '', e = '', conv = ''
  const mk = async (n: string, interests = "'{}'") => { const id = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id; await db.query(`update public.profiles set interests = ${interests} where id = $1`, [id]); return id }
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => {
    a = await mk('pplalice', `array['Music','Art']`); b = await mk('pplbob', `array['Music']`); c = await mk('pplcarol', `array['Art','Tech']`); d = await mk('ppldave', `array['Gaming']`); e = await mk('ppleve')
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted'), ($2, $3, 'accepted')`, [a, b, c])     // a–b and b–c friends: b is the mutual
    await db.query(`insert into public.blocks (blocker, blocked) values ($1, $2)`, [a, e])
    await db.query(`insert into public.follows (follower, target_type, target_id) values ($1, 'profile', $2), ($3, 'profile', $2)`, [d, a, b])         // d and b follow a
    await db.query(`update public.profiles set follow_policy = 'friends' where id = $1`, [d])
  })

  it('suggestions: "follow back" first, then mutual friends, then shared interests; never blocked, followed or friends-only accounts', async () => {
    const s = (await as(a, `select public.people_suggestions() as s`))[0].s as { id: string; follows_me: boolean; mutual: number; shared: string[] }[]
    const ids = s.map(x => x.id)
    expect(ids).not.toContain(a); expect(ids).not.toContain(e)                         // not yourself, not someone you blocked
    expect(ids).not.toContain(d)                                                       // d only accepts friends as followers
    const bob = s.find(x => x.id === b)!, carol = s.find(x => x.id === c)!
    expect(bob.follows_me).toBe(true); expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(c))   // follows you → first
    expect(carol).toMatchObject({ follows_me: false, mutual: 1 }); expect(carol.shared).toEqual(['Art'])
    await as(a, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [c])
    expect(((await as(a, `select public.people_suggestions() as s`))[0].s as { id: string }[]).map(x => x.id)).not.toContain(c)   // already followed
    expect(((await as(e, `select public.people_suggestions() as s`))[0].s as { id: string }[]).map(x => x.id)).not.toContain(a)    // blocked either way
    await expect(as(null, `select public.people_suggestions()`)).rejects.toThrow()
  })

  it('profile stats report posts you may see and whether they follow you; "followed by" shows only people you know', async () => {
    await as(b, `insert into public.posts (author, body, visibility) values (auth.uid(), 'public one', 'public'), (auth.uid(), 'friends one', 'friends'), (auth.uid(), 'public two', 'public')`)
    const st = async (uid: string, of: string) => (await as(uid, `select public.profile_stats($1) as s`, [of]))[0].s as Record<string, any>
    expect((await st(a, b)).posts).toBe(3)                                              // friend sees the friends-only post too
    expect((await st(d, b)).posts).toBe(2)                                              // a stranger sees only public ones
    expect(await st(a, d)).toMatchObject({ follows_me: true })
    expect(await st(a, c)).toMatchObject({ follows_me: false, i_follow: true })
    const fb = (await as(a, `select public.profile_followed_by($1) as f`, [c]))[0].f as { count: number; people: { username: string }[] }
    expect(fb.count).toBe(0)
    await db.query(`insert into public.follows (follower, target_type, target_id) values ($1, 'profile', $2)`, [b, c])
    const fb2 = (await as(a, `select public.profile_followed_by($1) as f`, [c]))[0].f as { count: number; people: { username: string }[] }
    expect(fb2).toMatchObject({ count: 1 }); expect(fb2.people[0].username).toBe('pplbob')
    expect(((await as(a, `select public.profile_followed_by($1) as f`, [a]))[0].f as { count: number }).count).toBe(0)
    expect(((await as(e, `select public.profile_followed_by($1) as f`, [a]))[0].f as { count: number }).count).toBe(0)         // blocked
  })

  it('messages: photos and voice notes need a real owner folder and a content; non-members cannot read them', async () => {
    conv = (await as(a, `select public.start_dm($1) as c`, [b]))[0].c
    await as(a, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'hello')`, [conv])
    await as(a, `insert into public.messages (conversation_id, sender, body, media_path, media_type) values ($1, auth.uid(), '', $2, 'image')`, [conv, `${a}/photo.jpg`])
    await as(a, `insert into public.messages (conversation_id, sender, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 8200)`, [conv, `${a}/voice.webm`])
    await fails(a, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), '')`, [conv])                                                        // empty message
    await fails(a, `insert into public.messages (conversation_id, sender, body, media_path, media_type) values ($1, auth.uid(), '', $2, 'image')`, [conv, `${b}/steal.jpg`])   // someone else's folder
    await fails(a, `insert into public.messages (conversation_id, sender, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 100000000)`, [conv, `${a}/long.webm`])       // only the 24 h sanity bound remains
    await fails(a, `insert into public.messages (conversation_id, sender, body, media_path) values ($1, auth.uid(), '', $2)`, [conv, `${a}/x.jpg`])                             // type required
    await fails(c, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'intruder')`, [conv])
    expect(await as(b, `select 1 from public.messages where conversation_id = $1`, [conv])).toHaveLength(3)
    expect(await as(c, `select 1 from public.messages where conversation_id = $1`, [conv])).toHaveLength(0)
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2)`, [`${a}/photo.jpg`, `${a}/voice.webm`])
    expect(await as(b, `select 1 from storage.objects where name = $1`, [`${a}/photo.jpg`])).toHaveLength(1)        // the other person can open it
    expect(await as(c, `select 1 from storage.objects where name = $1`, [`${a}/photo.jpg`])).toHaveLength(0)        // a bystander cannot
    expect(await as(c, `select 1 from storage.objects where name = $1`, [`${a}/voice.webm`])).toHaveLength(0)
  })
})

describe('unlimited voice notes, chat files, device songs, unread count and calls', () => {
  let a = '', b = '', c = '', conv = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => { a = await mk('callalice'); b = await mk('callbob'); c = await mk('callcarol'); await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [a, b]); conv = (await as(a, `select public.start_dm($1) as c`, [b]))[0].c })

  it('voice notes can be long (no 60 s cap) in messages, comments and memory replies', async () => {
    await as(a, `insert into public.messages (conversation_id, sender, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 1800000)`, [conv, `${a}/half-hour.webm`])
    const post = (await as(a, `insert into public.posts (author, body) values (auth.uid(), 'p') returning id`))[0].id
    await as(a, `insert into public.comments (post_id, author, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 600000)`, [post, `${a}/c.webm`])
    await fails(a, `insert into public.messages (conversation_id, sender, body, audio_path, audio_ms) values ($1, auth.uid(), '', $2, 100)`, [conv, `${a}/tiny.webm`])
  })

  it('chat files of any type are allowed in the sender folder, never executables, and only conversation members can open them', async () => {
    await as(a, `insert into public.messages (conversation_id, sender, body, file_path, file_name, file_size, file_mime) values ($1, auth.uid(), '', $2, 'report.pdf', 120000, 'application/pdf')`, [conv, `${a}/r.pdf`])
    await fails(a, `insert into public.messages (conversation_id, sender, body, file_path, file_name) values ($1, auth.uid(), '', $2, 'x.pdf')`, [conv, `${b}/steal.pdf`])
    await fails(a, `insert into public.messages (conversation_id, sender, body, file_path) values ($1, auth.uid(), '', $2)`, [conv, `${a}/noname.pdf`])      // name required with the path
    await asServer(`insert into storage.buckets (id, name) values ('attachments', 'attachments') on conflict do nothing`)
    await asServer(`insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`${a}/r.pdf`])
    expect(await as(b, `select 1 from storage.objects where bucket_id = 'attachments' and name = $1`, [`${a}/r.pdf`])).toHaveLength(1)
    expect(await as(c, `select 1 from storage.objects where bucket_id = 'attachments' and name = $1`, [`${a}/r.pdf`])).toHaveLength(0)
    await fails(a, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`${a}/virus.exe`])
    await fails(a, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`${b}/other.pdf`])
  })

  it('a song from the device is stored under the author folder and readable where the post is', async () => {
    await as(a, `insert into public.posts (author, body, music_path, visibility) values (auth.uid(), 'song', $1, 'public')`, [`${a}/song.mp3`])
    await fails(a, `insert into public.posts (author, body, music_path) values (auth.uid(), 'song', $1)`, [`${b}/song.mp3`])
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${a}/song.mp3`])
    expect(await as(c, `select 1 from storage.objects where name = $1`, [`${a}/song.mp3`])).toHaveLength(1)
  })

  it('unread_messages counts other people’s new messages and is capped', async () => {
    expect((await as(b, `select public.unread_messages() as n`))[0].n).toBeGreaterThanOrEqual(2)
    await as(b, `update public.conversation_members set last_read_at = now() + interval '1 minute' where conversation_id = $1 and user_id = auth.uid()`, [conv])
    expect((await as(b, `select public.unread_messages() as n`))[0].n).toBe(0)
    expect((await as(a, `select public.unread_messages() as n`))[0].n).toBe(0)                    // your own messages never count
    await expect(as(null, `select public.unread_messages()`)).rejects.toThrow()
  })

  it('calls: only the two people ring each other, blocked or busy callers are refused, and the token gate follows the call state', async () => {
    await fails(c, `select public.start_call($1, 'video')`, [conv])                                                    // not in the conversation
    const call = (await as(a, `select public.start_call($1, 'video') as c`, [conv]))[0].c as { id: string; room: string }
    expect(call.room).toMatch(/^call-/)
    expect(await as(c, `select 1 from public.calls where id = $1`, [call.id])).toHaveLength(0)                       // strangers cannot see calls
    expect(await as(b, `select 1 from public.calls where id = $1`, [call.id])).toHaveLength(1)
    await fails(b, `select public.call_token_gate($1)`, [call.id])                                                    // callee must answer first
    expect(((await as(a, `select public.call_token_gate($1) as g`, [call.id]))[0].g as { role: string }).role).toBe('caller')
    await fails(a, `select public.respond_call($1, true)`, [call.id])                                                 // caller cannot answer their own call
    await as(b, `select public.respond_call($1, true)`, [call.id])
    expect(((await as(b, `select public.call_token_gate($1) as g`, [call.id]))[0].g as { role: string }).role).toBe('callee')
    await fails(c, `select public.call_token_gate($1)`, [call.id])
    await as(a, `select public.end_call($1)`, [call.id])
    await fails(b, `select public.call_token_gate($1)`, [call.id])                                                    // ended
    expect((await asServer(`select status from public.calls where id = $1`, [call.id]))[0].status).toBe('ended')
    await db.query(`insert into public.blocks (blocker, blocked) values ($1, $2)`, [b, a])
    await fails(a, `select public.start_call($1, 'audio')`, [conv])                                                   // blocked
    await fails(a, `select public.start_call($1, 'screen')`, [conv])
  })
})

describe('end-to-end encrypted chat storage', () => {
  let a = '', b = '', c = '', conv = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const KEY = 'BA' + 'A'.repeat(86)   // looks like a base64 P-256 point (88 chars)

  it('setup', async () => { a = await mk('e2eealice'); b = await mk('e2eebob'); c = await mk('e2eecarol'); await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [a, b]); conv = (await as(a, `select public.start_dm($1) as c`, [b]))[0].c })

  const BK = `{"v":1,"salt":"x","iv":"y","ct":"z","iter":600000}`
  it('public keys: only the owner can publish theirs (through the audited function); only people you chat with can read it', async () => {
    await as(a, `select public.publish_chat_key($1, $2::jsonb)`, [KEY, BK])
    await fails(a, `insert into public.chat_keys (user_id, public_key) values (auth.uid(), $1)`, [KEY.replace('BA', 'BB')])           // no direct writes any more
    await fails(a, `update public.chat_keys set public_key = $1 where user_id = auth.uid()`, [KEY.replace('BA', 'BB')])
    // The request the older app sent (an upsert also rewrites user_id), which is what showed "permission denied for table chat_keys".
    await expect(as(a, `insert into public.chat_keys (user_id, public_key, updated_at) values (auth.uid(), $1, now()) on conflict (user_id) do update set user_id = excluded.user_id, public_key = excluded.public_key, updated_at = excluded.updated_at`, [KEY])).rejects.toThrow(/permission denied/)
    await fails(b, `select public.publish_chat_key('not a key!', $1::jsonb)`, [BK])                                                  // shape check
    await fails(b, `select public.publish_chat_key($1, '[]'::jsonb)`, [KEY])                                                         // backup must be an object
    await as(b, `select public.publish_chat_key($1, $2::jsonb)`, [KEY.replace('BA', 'BB'), BK])
    expect(await as(b, `select 1 from public.chat_keys where user_id = $1`, [a])).toHaveLength(1)                                    // chat partner can read it
    expect(await as(c, `select 1 from public.chat_keys where user_id = $1`, [a])).toHaveLength(0)                                    // a stranger cannot
    expect(await as(a, `select 1 from public.chat_keys where user_id = $1`, [b])).toHaveLength(1)
  })

  it('key backups are private to their owner and cannot be edited directly', async () => {
    expect(await as(b, `select 1 from public.chat_key_backups where user_id = $1`, [a])).toHaveLength(0)
    expect(await as(a, `select 1 from public.chat_key_backups`)).toHaveLength(1)
    await fails(a, `update public.chat_key_backups set escrow = true where user_id = auth.uid()`)                                    // the escrow flag is not the client's to set
    await fails(a, `insert into public.chat_key_backups (user_id, backup) values (auth.uid(), '{}')`)
  })

  it('calls remember whether the caller made them end-to-end encrypted', async () => {
    const call = (await as(a, `select public.start_call($1, 'audio', true) as c`, [conv]))[0].c as { id: string; encrypted: boolean }
    expect(call.encrypted).toBe(true)
    expect((await as(b, `select encrypted from public.calls where id = $1`, [call.id]))[0].encrypted).toBe(true)         // the callee sees it before answering
    await as(a, `select public.end_call($1)`, [call.id])
    expect(((await as(a, `select public.start_call($1, 'audio') as c`, [conv]))[0].c as { encrypted: boolean }).encrypted).toBe(false)   // default stays off
  })

  it('encrypted messages must carry ciphertext, may be larger than plain ones, and can still be deleted', async () => {
    const ct = 'e2ee1.' + 'A'.repeat(11000)
    await as(a, `insert into public.messages (conversation_id, sender, body, e2ee) values ($1, auth.uid(), $2, true)`, [conv, ct])
    await fails(a, `insert into public.messages (conversation_id, sender, body, e2ee) values ($1, auth.uid(), 'plain text pretending to be encrypted', true)`, [conv])
    await fails(a, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), $2)`, [conv, 'A'.repeat(4001)])   // plain messages keep the 4000 cap
    const id = (await asServer(`select id from public.messages where e2ee limit 1`))[0].id
    await as(a, `update public.messages set deleted_at = now(), body = 'Message deleted' where id = $1`, [id])
    expect(await as(b, `select body from public.messages where id = $1`, [id])).toMatchObject([{ body: 'Message deleted' }])
    expect(await as(c, `select 1 from public.messages where conversation_id = $1`, [conv])).toHaveLength(0)
  })
})

describe('chat security: audit, recovery, escrow and encrypted groups', () => {
  let a = '', b = '', c = '', d = '', grp = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const key = (x: string) => 'BA' + x.repeat(86).slice(0, 86)
  const BK = '{"v":1,"salt":"x","iv":"y","ct":"z","iter":600000}'

  it('setup', async () => {
    a = await mk('secalice'); b = await mk('secbob'); c = await mk('seccarol'); d = await mk('secdave')
    for (const [x, y] of [[a, b], [a, c], [a, d]]) await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted')`, [x, y])
    for (const [u, k] of [[a, 'A'], [b, 'B'], [c, 'C']] as const) await as(u, `select public.publish_chat_key($1, $2::jsonb, $3::jsonb)`, [key(k), BK, '{"v":1}'])   // dave has no key yet
    grp = (await as(a, `select public.start_group('Crew', array[$1::uuid, $2::uuid, $3::uuid]) as g`, [b, c, d]))[0].g
  })

  it('every key change is audited and re-keying alerts the owner; too many changes are refused', async () => {
    const ev = await as(a, `select action from public.chat_key_events order by created_at`)
    expect(ev.map(r => r.action)).toEqual(['create'])
    await as(a, `select public.publish_chat_key($1, $2::jsonb)`, [key('Z'), BK])
    expect((await as(a, `select action from public.chat_key_events order by created_at desc limit 1`))[0].action).toBe('rotate')
    expect(await as(a, `select 1 from public.notifications where type = 'security'`)).toHaveLength(1)
    expect(await as(b, `select 1 from public.chat_key_events`)).toHaveLength(1)                                                       // each member sees only their own history
    for (let i = 0; i < 3; i++) await as(a, `select public.publish_chat_key($1, $2::jsonb)`, [key(String(i)), BK])
    await fails(a, `select public.publish_chat_key($1, $2::jsonb)`, [key('Q'), BK])
  })

  it('backups: the passphrase and recovery backups can be replaced through the function only', async () => {
    await asServer(`delete from public.chat_key_events where user_id = $1`, [b])
    await as(b, `select public.update_chat_backups('{"v":1,"salt":"n","iv":"n","ct":"n","iter":600000}'::jsonb, null)`)
    expect((await as(b, `select backup ->> 'salt' as s from public.chat_key_backups`))[0].s).toBe('n')
    await fails(b, `select public.update_chat_backups('[]'::jsonb, null)`)
    await fails(d, `select public.update_chat_backups('{"v":1}'::jsonb, null)`)                                                       // no secure chat yet
    expect((await as(b, `select action from public.chat_key_events order by created_at desc limit 1`))[0].action).toBe('passphrase')
  })

  it('escrow and recovery requests are invisible to the browser roles; only one request can be active; anyone on the account can cancel', async () => {
    await asServer(`insert into public.chat_key_escrow (user_id, blob) values ($1, $2)`, [c, 'v1.' + 'x'.repeat(60)])
    await fails(c, `select blob from public.chat_key_escrow`)
    await fails(c, `insert into public.chat_key_escrow (user_id, blob) values (auth.uid(), 'v1.${'y'.repeat(60)}')`)
    await asServer(`insert into public.chat_recovery_requests (user_id, ready_at, expires_at) values ($1, now() + interval '72 hours', now() + interval '10 days')`, [c])
    await expect(asServer(`insert into public.chat_recovery_requests (user_id, ready_at, expires_at) values ($1, now() + interval '72 hours', now() + interval '10 days')`, [c])).rejects.toThrow()
    expect(await as(c, `select 1 from public.chat_recovery_requests`)).toHaveLength(1)
    expect(await as(b, `select 1 from public.chat_recovery_requests`)).toHaveLength(0)
    const id = (await as(c, `select id from public.chat_recovery_requests`))[0].id
    await fails(b, `select public.cancel_recovery_request($1)`, [id])                                                                 // not yours
    await as(c, `select public.cancel_recovery_request($1)`, [id])
    expect((await as(c, `select status from public.chat_recovery_requests`))[0].status).toBe('cancelled')
    await fails(c, `select public.cancel_recovery_request($1)`, [id])
  })

  it('re-keying removes the escrow copy and any recovery in progress', async () => {
    await asServer(`update public.chat_key_backups set escrow = true where user_id = $1`, [c])
    await asServer(`insert into public.chat_recovery_requests (user_id, ready_at, expires_at) values ($1, now() + interval '72 hours', now() + interval '10 days')`, [c])
    await as(c, `select public.publish_chat_key($1, $2::jsonb)`, [key('K'), BK])
    expect(await asServer(`select 1 from public.chat_key_escrow where user_id = $1`, [c])).toHaveLength(0)
    expect((await asServer(`select escrow from public.chat_key_backups where user_id = $1`, [c]))[0].escrow).toBe(false)
    expect(await asServer(`select 1 from public.chat_recovery_requests where user_id = $1 and status = 'waiting'`, [c])).toHaveLength(0)
  })

  it('security events from the service role record an audit row and alert the member; browsers cannot call it', async () => {
    await fails(a, `select public.chat_security_event($1, 'escrow_on')`, [a])
    await asServer(`select public.chat_security_event($1, 'recovery_requested', '{"hours":72}')`, [b])
    expect((await as(b, `select action from public.chat_key_events order by created_at desc limit 1`))[0].action).toBe('recovery_requested')
    expect((await as(b, `select 1 from public.notifications where type = 'security'`)).length).toBeGreaterThanOrEqual(1)
  })

  it('group keys: any member can turn encryption on once; keys are delivered per member and read only by that member', async () => {
    await fails(d, `select public.start_group_encryption($1)`, [(await as(a, `select public.start_dm($1) as c`, [b]))[0].c])        // not a group
    await fails((await mk('secoutsider')), `select public.start_group_encryption($1)`, [grp])
    expect((await as(a, `select public.start_group_encryption($1) as e`, [grp]))[0].e).toEqual({ epoch: 1, created: true })
    // nobody has received a key yet, so a second member starting now begins a fresh epoch (a group is never stuck without a key)
    expect((await as(b, `select public.start_group_encryption($1) as e`, [grp]))[0].e).toEqual({ epoch: 2, created: true })
    await asServer(`update public.conversations set key_epoch = 1 where id = $1`, [grp])                                                  // back to a single epoch for the rest of the test
    const need = (await as(a, `select public.group_key_status($1, 1) as s`, [grp]))[0].s as { user_id: string }[]
    expect(need.map(x => x.user_id).sort()).toEqual([a, b, c].sort())                                                                // dave has no published key yet
    await as(a, `insert into public.conversation_keys (conversation_id, user_id, epoch, wrapped, wrapped_by) values ($1, $2, 1, $3, auth.uid())`, [grp, a, 'w'.repeat(60)])
    await as(a, `insert into public.conversation_keys (conversation_id, user_id, epoch, wrapped, wrapped_by) values ($1, $2, 1, $3, auth.uid())`, [grp, b, 'w'.repeat(60)])
    expect((await as(c, `select public.start_group_encryption($1) as e`, [grp]))[0].e).toEqual({ epoch: 1, created: false })               // once a key has been delivered, starting again changes nothing
    await fails(a, `insert into public.conversation_keys (conversation_id, user_id, epoch, wrapped, wrapped_by) values ($1, $2, 1, $3, $4)`, [grp, c, 'w'.repeat(60), b]) // cannot claim to be someone else
    await fails(a, `insert into public.conversation_keys (conversation_id, user_id, epoch, wrapped, wrapped_by) values ($1, $2, 2, $3, auth.uid())`, [grp, c, 'w'.repeat(60)]) // epoch not started
    await fails(b, `insert into public.conversation_keys (conversation_id, user_id, epoch, wrapped, wrapped_by) values ($1, $2, 1, $3, auth.uid())`, [grp, (await mk('secstranger')), 'w'.repeat(60)])   // not a member
    expect(await as(b, `select 1 from public.conversation_keys`)).toHaveLength(1)                                                    // b sees only their own row
    expect(await as(c, `select 1 from public.conversation_keys`)).toHaveLength(0)
    const left = (await as(a, `select public.group_key_status($1, 1) as s`, [grp]))[0].s as { user_id: string }[]
    expect(left.map(x => x.user_id)).toEqual([c])
    await as(b, `delete from public.conversation_keys where user_id = auth.uid()`)                                                    // a member may drop their own (bad) copy
    expect(((await as(a, `select public.group_key_status($1, 1) as s`, [grp]))[0].s as unknown[]).length).toBe(2)
  })

  it('an encrypted group refuses plain messages, plain attachments and invalid epochs; encrypted ones go through', async () => {
    const ct = 'e2ee1.' + 'A'.repeat(100)
    await fails(a, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'hello everyone')`, [grp])
    await fails(a, `insert into public.messages (conversation_id, sender, body, e2ee) values ($1, auth.uid(), $2, true)`, [grp, ct])                // epoch missing
    await fails(a, `insert into public.messages (conversation_id, sender, body, e2ee, key_epoch) values ($1, auth.uid(), $2, true, 5)`, [grp, ct])  // future epoch
    await as(a, `insert into public.messages (conversation_id, sender, body, e2ee, key_epoch) values ($1, auth.uid(), $2, true, 1)`, [grp, ct])
    await fails(a, `insert into public.messages (conversation_id, sender, body, e2ee, key_epoch, media_path, media_type) values ($1, auth.uid(), $2, true, 1, $3, 'image')`, [grp, ct, `${a}/p.jpg`])
    expect(await as(c, `select 1 from public.messages where conversation_id = $1`, [grp])).toHaveLength(1)
    const dm = (await as(a, `select public.start_dm($1) as c`, [b]))[0].c
    await fails(a, `insert into public.messages (conversation_id, sender, body, e2ee, key_epoch) values ($1, auth.uid(), $2, true, 1)`, [dm, ct])      // epochs only exist in encrypted groups
    await as(a, `insert into public.messages (conversation_id, sender, body) values ($1, auth.uid(), 'plain chats still work')`, [dm])
  })
})

describe('posts with only a song, feeling or place; 14-day name changes', () => {
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  let u = ''
  it('a song, feeling or place alone is not a post (migration 34 reversed migration 15); with words it is', async () => {
    u = await mk('namealice')
    await fails(u, `insert into public.posts (author, body, music_title, music_artist) values (auth.uid(), '', 'Song', 'Artist')`)
    await fails(u, `insert into public.posts (author, body, feeling) values (auth.uid(), '', 'happy')`)
    await fails(u, `insert into public.posts (author, body, place_name) values (auth.uid(), '', 'Cape Town')`)
    await fails(u, `insert into public.posts (author, body) values (auth.uid(), '')`)
    await as(u, `insert into public.posts (author, body, feeling, music_title, music_artist) values (auth.uid(), 'Sunday vibes', 'happy', 'Song', 'Artist')`)
  })
  it('lets a new member set a name during onboarding, then limits changes to once every 14 days', async () => {
    await as(u, `update public.profiles set display_name = 'First pick' where id = auth.uid()`)                     // not onboarded yet: free
    await as(u, `update public.profiles set display_name = 'Second pick', onboarded_at = now() where id = auth.uid()`)
    expect((await as(u, `select public.my_profile()->>'display_name_changed_at' as display_name_changed_at`))[0].display_name_changed_at).toBeNull()
    await as(u, `update public.profiles set display_name = 'Chief' where id = auth.uid()`)                           // first change after onboarding
    expect((await as(u, `select public.my_profile()->>'display_name_changed_at' as display_name_changed_at`))[0].display_name_changed_at).not.toBeNull()
    await expect(as(u, `update public.profiles set display_name = 'Too soon' where id = auth.uid()`)).rejects.toThrow(/change your name again/)
    await as(u, `update public.profiles set display_name = 'Chief', bio = 'saving other fields still works' where id = auth.uid()`)  // same name: allowed
    await fails(u, `update public.profiles set display_name_changed_at = now() - interval '30 days' where id = auth.uid()`)       // cannot reset the clock
    await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
    await db.query(`update public.profiles set display_name_changed_at = now() - interval '15 days' where id = $1`, [u])         // server/admin time travel
    await as(u, `update public.profiles set display_name = 'Chief DAWG' where id = auth.uid()`)
    expect((await as(u, `select display_name from public.profiles where id = auth.uid()`))[0].display_name).toBe('Chief DAWG')
  })
})

describe('campaigns: placements, honest labels, organisation submissions and admin review', () => {
  let admin = '', owner = '', editor = '', stranger = '', member = '', org = '', other = '', camp = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const uuid = () => crypto.randomUUID()
  it('setup', async () => {
    admin = await mk('cmpadmin'); owner = await mk('cmpowner'); editor = await mk('cmpeditor'); stranger = await mk('cmpstranger'); member = await mk('cmpmember')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    org = (await as(owner, `insert into public.organizations (name, slug, kind, created_by) values ('Sound Co', 'sound-co', 'organizer', auth.uid()) returning id`))[0].id
    other = (await as(stranger, `insert into public.organizations (name, slug, kind, created_by) values ('Other Co', 'other-co', 'brand', auth.uid()) returning id`))[0].id
    await db.query(`insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'editor', 'active')`, [org, editor])
  })
  it('platform slides choose placements and an honest kind; bad values are refused', async () => {
    const h = (await as(admin, `insert into public.promo_slides (title, cta_url, status, kind, placements) values ('From VYBE', '/app/discover', 'live', 'house', '{discover}') returning kind, placements`))[0]
    expect(h).toEqual({ kind: 'house', placements: ['discover'] })
    await fails(admin, `insert into public.promo_slides (title, cta_url, placements) values ('Bad', '/app/plans', '{feed}')`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, placements) values ('Bad', '/app/plans', '{}')`)
    await fails(admin, `insert into public.promo_slides (title, cta_url, kind) values ('Bad', '/app/plans', 'native')`)
    expect((await as(admin, `insert into public.promo_slides (title, cta_url) values ('Old style', '/app/plans') returning placements, kind`))[0]).toEqual({ placements: ['home'], kind: 'sponsored' })
  })
  it('an organisation owner drafts a campaign; it always advertises as the organisation, as sponsored, at default priority', async () => {
    const r = (await as(owner, `insert into public.promo_slides (title, cta_url, organization_id, advertiser, kind, priority, placements) values ('Our festival', 'https://soundco.example/fest', $1, 'Someone Famous', 'house', 99, '{home,discover}') returning id, advertiser, kind, priority, status`, [org]))[0]
    camp = r.id
    expect([r.advertiser, r.kind, r.priority, r.status]).toEqual(['Sound Co', 'sponsored', 50, 'draft'])
    await fails(owner, `insert into public.promo_slides (title, cta_url, organization_id, status) values ('Straight to live', '/app/plans', $1, 'live')`, [org])
    await fails(editor, `insert into public.promo_slides (title, cta_url, organization_id) values ('Editor', '/app/plans', $1)`, [org])      // editors cannot run campaigns
    await fails(stranger, `insert into public.promo_slides (title, cta_url, organization_id) values ('Not mine', '/app/plans', $1)`, [org])
    await fails(owner, `insert into public.promo_slides (title, cta_url) values ('Platform row', '/app/plans')`)                          // no organisation = platform only
    expect(await as(stranger, `select 1 from public.promo_slides where id = $1`, [camp])).toHaveLength(0)
    expect(await as(member, `select 1 from public.promo_slides where id = $1`, [camp])).toHaveLength(0)
  })
  it('organisations cannot approve, publish, re-home or borrow another organisation’s media', async () => {
    await fails(owner, `update public.promo_slides set status = 'live' where id = $1`, [camp])
    await fails(owner, `update public.promo_slides set organization_id = $2 where id = $1`, [camp, other])
    await fails(owner, `update public.promo_slides set media_type = 'image', media_path = $2 where id = $1`, [camp, `promo/o-${other}/${uuid()}.png`])
    await fails(owner, `update public.promo_slides set media_type = 'image', media_path = $2 where id = $1`, [camp, `promo/${uuid()}.png`])
    await as(owner, `update public.promo_slides set media_type = 'image', media_path = $2 where id = $1`, [camp, `promo/o-${org}/${uuid()}.png`])
    await as(owner, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/o-${org}/${uuid()}.png`])
    await fails(owner, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/o-${other}/${uuid()}.png`])
    await fails(owner, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/${uuid()}.png`])
    await fails(editor, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`promo/o-${org}/${uuid()}.png`])
  })
  it('submit → reject (reason required, notified, audited) → fix and resubmit → approve; then it is locked to the organisation', async () => {
    const sub = (await as(owner, `update public.promo_slides set status = 'submitted' where id = $1 returning submitted_at`, [camp]))[0]
    expect(sub.submitted_at).not.toBeNull()
    await fails(admin, `update public.promo_slides set status = 'rejected' where id = $1`, [camp])
    await as(admin, `update public.promo_slides set status = 'rejected', review_note = 'The link must go to the festival page.' where id = $1`, [camp])
    const n = await as(owner, `select type from public.notifications where type = 'campaign'`)
    expect(n).toHaveLength(1)
    expect((await as(owner, `select review_note, status from public.promo_slides where id = $1`, [camp]))[0]).toEqual({ review_note: 'The link must go to the festival page.', status: 'rejected' })
    await fails(owner, `update public.promo_slides set title = 'Still rejected' where id = $1`, [camp])                             // a rejected campaign goes back to draft or submitted
    await as(owner, `update public.promo_slides set review_note = 'approved by me', status = 'draft' where id = $1`, [camp])        // the note is ignored: only VYBE writes review notes
    expect((await as(owner, `select review_note from public.promo_slides where id = $1`, [camp]))[0].review_note).toBe('The link must go to the festival page.')
    await as(owner, `update public.promo_slides set cta_url = 'https://soundco.example/festival', status = 'submitted' where id = $1`, [camp])
    expect((await as(owner, `select review_note from public.promo_slides where id = $1`, [camp]))[0].review_note).toBe('The link must go to the festival page.')
    await as(admin, `update public.promo_slides set status = 'live', priority = 70 where id = $1`, [camp])
    const live = (await as(owner, `select status, review_note, reviewed_by, priority from public.promo_slides where id = $1`, [camp]))[0]
    expect([live.status, live.review_note, live.reviewed_by, live.priority]).toEqual(['live', null, admin, 70])
    expect(await as(member, `select 1 from public.promo_slides where id = $1`, [camp])).toHaveLength(1)                              // members now see it
    expect(await as(owner, `update public.promo_slides set title = 'Edited after approval' where id = $1 returning id`, [camp])).toHaveLength(0)
    expect(await as(owner, `delete from public.promo_slides where id = $1 returning id`, [camp])).toHaveLength(0)
    expect(await as(owner, `select type from public.notifications where type = 'campaign'`)).toHaveLength(2)
    const audit = await db.query<{ action: string }>(`select action from public.audit_log where entity_id = $1 order by id`, [camp])
    expect(audit.rows.map(r => r.action)).toEqual(['campaign.draft', 'campaign.submitted', 'campaign.rejected', 'campaign.draft', 'campaign.submitted', 'campaign.live'])
  })
  it('organisations read only their own statistics', async () => {
    await as(member, `select public.promo_track($1, 'impression')`, [camp])
    expect((await as(owner, `select impressions from public.promo_stats where slide_id = $1`, [camp]))[0].impressions).toBe(1)
    expect(await as(stranger, `select 1 from public.promo_stats where slide_id = $1`, [camp])).toHaveLength(0)
    expect(await as(member, `select 1 from public.promo_stats`)).toHaveLength(0)
  })
})

describe('profile privacy: private columns are readable only by their owner', () => {
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  it('others see the public profile but not coordinates, settings, onboarding answers or country', async () => {
    const owner = await mk('privowner'), other = await mk('privother')
    await as(owner, `update public.profiles set lat = -33.9, lng = 18.4, country = 'ZA', intents = '{music}', notif_prefs = '{"likes": false}' where id = auth.uid()`)
    expect((await as(other, `select username, display_name, avatar_path, bio, interests, location from public.profiles where id = $1`, [owner]))).toHaveLength(1)
    for (const col of ['lat', 'lng', 'country', 'intents', 'notif_prefs', 'onboarding_step', 'onboarded_at', 'display_name_changed_at']) {
      await fails(other, `select ${col} from public.profiles where id = $1`, [owner])
      await fails(owner, `select ${col} from public.profiles where id = auth.uid()`)                                   // direct reads go through my_profile()
    }
    await fails(other, `select * from public.profiles where id = $1`, [owner])
    const mine = (await as(owner, `select public.my_profile() as p`))[0].p
    expect([mine.lat, mine.country, mine.notif_prefs.likes, mine.username]).toEqual([-33.9, 'ZA', false, 'privowner'])
    expect((await as(other, `select public.my_profile() as p`))[0].p.username).toBe('privother')                        // only ever your own row
    await fails(null, `select public.my_profile()`)
  })
})

describe('migration 18: media read policy (lineup images and community covers)', () => {
  let alice = '', bob = '', admin = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => {
    alice = await mk('m14alice'); bob = await mk('m14bob'); admin = await mk('m14admin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
  })

  it('a public community cover and a lineup image are readable by other members (they were not: `name` bound to the row)', async () => {
    const cover = `${alice}/cover.jpg`, act = `${alice}/act.jpg`
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2)`, [cover, act])
    const c = (await as(alice, `insert into public.communities (name, created_by) values ('Surfers', auth.uid()) returning id`))[0].id
    await as(alice, `update public.communities set cover_path = $1 where id = $2`, [cover, c])
    const ev = (await as(alice, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Gig', now() + interval '1 day') returning id`))[0].id
    await as(alice, `insert into public.event_lineup (event_id, name, image_path) values ($1, 'DJ Wave', $2)`, [ev, act])
    expect(await as(bob, `select 1 from storage.objects where name = $1`, [cover])).toHaveLength(1)
    expect(await as(bob, `select 1 from storage.objects where name = $1`, [act])).toHaveLength(1)
  })

  it('still hides files nobody visible points at, and a private community cover from non-members', async () => {
    const stray = `${alice}/stray.jpg`, secret = `${alice}/secret.jpg`
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2)`, [stray, secret])
    expect(await as(bob, `select 1 from storage.objects where name = $1`, [stray])).toHaveLength(0)
    const c = (await as(alice, `insert into public.communities (name, created_by, visibility) values ('Hidden', auth.uid(), 'private') returning id`))[0].id
    await as(alice, `update public.communities set cover_path = $1 where id = $2`, [secret, c])
    const visible = await as(bob, `select 1 from public.communities where id = $1`, [c])
    expect(await as(bob, `select 1 from storage.objects where name = $1`, [secret])).toHaveLength(visible.length)   // exactly what communities RLS allows
  })
})

describe('migration 18: visibility helpers are not callable signed out', () => {
  it('anon cannot ask whether two members are friends or have blocked each other; members and the sign-in hero still work', async () => {
    const [a, b] = (await db.query<{ id: string }>(`select id from public.profiles order by username limit 2`)).rows.map(r => r.id)
    await fails(null, `select public.are_friends($1, $2)`, [a, b])
    await fails(null, `select public.is_blocked($1, $2)`, [a, b])
    await fails(null, `select public.is_conversation_member(gen_random_uuid())`)
    expect(await as(a, `select public.are_friends(auth.uid(), $1) as f`, [b])).toHaveLength(1)
    expect(await as(a, `select public.is_conversation_member(gen_random_uuid()) as m`)).toEqual([{ m: false }])
    expect(await as(null, `select public.get_auth_hero() is not null as ok`)).toHaveLength(1)                 // the signed-out sign-in page
    expect(await as(a, `select count(*)::int as n from public.posts`)).toHaveLength(1)                         // policies that call the helpers still run
  })
})

describe('migration 19: organisation portal (identity, roles, history, overview)', () => {
  let owner = '', adminM = '', editor = '', outsider = '', org = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup: an owner, an admin, an editor and an outsider', async () => {
    owner = await mk('m19owner'); adminM = await mk('m19admin'); editor = await mk('m19editor'); outsider = await mk('m19out')
    org = (await as(owner, `insert into public.organizations (name, slug, kind, created_by) values ('Sea Sound', 'sea-sound', 'venue', auth.uid()) returning id`))[0].id
    for (const [u, r] of [[adminM, 'admin'], [editor, 'editor']]) {
      await as(owner, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)`, [org, u, r])
      await as(u, `update public.organization_members set status = 'active' where organization_id = $1 and user_id = auth.uid()`, [org])
    }
  })

  it('admins save identity (website, links, location, logo and cover from their own uploads); it persists', async () => {
    const logo = `${adminM}/logo.png`, cover = `${adminM}/cover.jpg`
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2)`, [logo, cover])
    const r = await as(adminM, `update public.organizations set website = 'https://seasound.example', location = 'Muizenberg', links = $2::jsonb, avatar_path = $3, cover_path = $4 where id = $1 returning website, location, links, avatar_path, cover_path`,
      [org, JSON.stringify([{ label: 'Instagram', url: 'https://instagram.com/seasound' }]), logo, cover])
    expect(r).toHaveLength(1)
    expect((await as(outsider, `select website, location, links from public.organizations where id = $1`, [org]))[0]).toEqual({ website: 'https://seasound.example', location: 'Muizenberg', links: [{ label: 'Instagram', url: 'https://instagram.com/seasound' }] })
  })

  it('logo and cover are readable by other members (they were not: the media rule listed no organisations column)', async () => {
    expect(await as(outsider, `select 1 from storage.objects where name = $1`, [`${adminM}/logo.png`])).toHaveLength(1)
    expect(await as(outsider, `select 1 from storage.objects where name = $1`, [`${adminM}/cover.jpg`])).toHaveLength(1)
  })

  it('an admin cannot point the page at someone else\'s file, or save non-https or malformed links', async () => {
    const theirs = `${outsider}/private.jpg`
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [theirs])
    await fails(adminM, `update public.organizations set avatar_path = $2 where id = $1`, [org, theirs])
    await fails(adminM, `update public.organizations set cover_path = $2 where id = $1`, [org, theirs])
    expect(await as(adminM, `select 1 from storage.objects where name = $1`, [theirs])).toHaveLength(0)
    await fails(adminM, `update public.organizations set website = 'http://insecure.example' where id = $1`, [org])
    await fails(adminM, `update public.organizations set links = '[{"label":"x","url":"javascript:alert(1)"}]' where id = $1`, [org])
    await fails(adminM, `update public.organizations set links = '[{"label":"","url":"https://ok.example"}]' where id = $1`, [org])
    const six = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `https://l${i}.example` })))
    await fails(adminM, `update public.organizations set links = $2::jsonb where id = $1`, [org, six])
  })

  it('editors and outsiders cannot change identity (the update matches no row)', async () => {
    expect(await as(editor, `update public.organizations set website = 'https://evil.example' where id = $1 returning id`, [org])).toHaveLength(0)
    expect(await as(outsider, `update public.organizations set location = 'x' where id = $1 returning id`, [org])).toHaveLength(0)
    await fails(adminM, `update public.organizations set slug = 'new-slug' where id = $1`, [org])   // the handle has no column grant
  })

  it('only the owner changes roles; nobody becomes owner; direct role writes stay closed', async () => {
    await fails(adminM, `select public.set_org_member_role($1, $2, 'admin')`, [org, editor])
    await fails(owner, `select public.set_org_member_role($1, $2, 'owner')`, [org, editor])
    await fails(owner, `select public.set_org_member_role($1, auth.uid(), 'editor')`, [org])
    await fails(owner, `select public.set_org_member_role($1, $2, 'admin')`, [org, outsider])
    await fails(adminM, `update public.organization_members set role = 'owner' where organization_id = $1 and user_id = auth.uid()`, [org])
    await as(owner, `select public.set_org_member_role($1, $2, 'admin')`, [org, editor])
    expect((await as(editor, `select public.org_role($1) as r`, [org]))[0].r).toBe('admin')
    await as(owner, `select public.set_org_member_role($1, $2, 'editor')`, [org, editor])
  })

  it('history: owners and admins read who changed what; editors and outsiders cannot', async () => {
    const h = (await as(adminM, `select public.org_activity($1) as h`, [org]))[0].h as { action: string; actor: { username: string } | null; detail: any }[]
    const actions = h.map(x => x.action)
    expect(actions).toContain('org.updated')
    expect(actions.filter(a => a === 'org.role_changed')).toHaveLength(2)
    expect(actions).toContain('org.member_invited')
    expect(h.find(x => x.action === 'org.updated')!.actor!.username).toBe('m19admin')
    expect(h.find(x => x.action === 'org.updated')!.detail.fields).toEqual(expect.arrayContaining(['website', 'links', 'avatar_path', 'cover_path']))
    await fails(editor, `select public.org_activity($1)`, [org])
    await fails(outsider, `select public.org_activity($1)`, [org])
    await fails(null, `select public.org_activity($1)`, [org])
  })

  it('overview: real counts for members; money and campaign figures only for owners and admins', async () => {
    await as(editor, `insert into public.events (host, title, starts_at, organization_id) values (auth.uid(), 'Sunset set', now() + interval '2 days', $1)`, [org])
    await as(outsider, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    const e = (await as(editor, `select public.org_overview($1) as o`, [org]))[0].o
    expect(e).toMatchObject({ events_upcoming: 1, members: 3, followers: 1, role: 'editor' })
    expect(e.next_event.title).toBe('Sunset set')
    expect(e).not.toHaveProperty('tickets_30d')
    expect(e).not.toHaveProperty('campaigns')
    const o = (await as(owner, `select public.org_overview($1) as o`, [org]))[0].o
    expect(o).toMatchObject({ tickets_30d: 0, impressions_30d: 0, clicks_30d: 0, campaigns: {} })
    await fails(outsider, `select public.org_overview($1)`, [org])
    await fails(null, `select public.org_overview($1)`, [org])
  })
})

describe('migration 20: organisation communities, notification settings, media library', () => {
  let owner = '', adminM = '', editor = '', member = '', outsider = '', org = '', ev = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const notes = async (uid: string, type: string) => (await asServer(`select entity_id from public.notifications where user_id = $1 and type = $2`, [uid, type])).length

  it('setup', async () => {
    owner = await mk('m20owner'); adminM = await mk('m20admin'); editor = await mk('m20editor'); member = await mk('m20member'); outsider = await mk('m20out')
    org = (await as(owner, `insert into public.organizations (name, slug, kind, created_by) values ('Tide Club', 'tide-club', 'organizer', auth.uid()) returning id`))[0].id
    for (const [u, r] of [[adminM, 'admin'], [editor, 'editor']]) {
      await as(owner, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)`, [org, u, r])
      await as(u, `update public.organization_members set status = 'active' where organization_id = $1 and user_id = auth.uid()`, [org])
    }
  })

  it('a new member joining notifies owners and admins (not editors, not the joiner)', async () => {
    expect(await notes(owner, 'org_member')).toBe(2)
    expect(await notes(adminM, 'org_member')).toBe(1)        // only the editor's join (their own is skipped)
    expect(await notes(editor, 'org_member')).toBe(0)
  })

  it('owners and admins create communities as the organisation; editors and outsiders cannot', async () => {
    const c = (await as(adminM, `insert into public.communities (name, created_by, organization_id) values ('Tide Riders', auth.uid(), $1) returning id`, [org]))[0].id
    expect(c).toBeTruthy()
    await fails(editor, `insert into public.communities (name, created_by, organization_id) values ('X', auth.uid(), $1)`, [org])
    await fails(outsider, `insert into public.communities (name, created_by, organization_id) values ('Y', auth.uid(), $1)`, [org])
  })

  it('organisation owners and admins moderate its communities without being members', async () => {
    const c = (await as(outsider, `insert into public.communities (name, created_by) values ('Night Swim', auth.uid()) returning id`))[0].id
    expect((await as(owner, `select public.community_role($1) as r`, [c]))[0].r).toBeNull()
    await fails(owner, `select public.set_community_organization($1, $2)`, [c, org])         // not the community owner
    await fails(outsider, `select public.set_community_organization($1, $2)`, [c, org])       // does not manage the organisation
    await as(owner, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'admin')`, [org, outsider])
    await as(outsider, `update public.organization_members set status = 'active' where organization_id = $1 and user_id = auth.uid()`, [org])
    await as(outsider, `select public.set_community_organization($1, $2)`, [c, org])
    expect((await as(owner, `select public.community_role($1) as r`, [c]))[0].r).toBe('admin')
    expect((await as(outsider, `select public.community_role($1) as r`, [c]))[0].r).toBe('owner')
    expect(await as(owner, `update public.communities set description = 'Run by Tide Club' where id = $1 returning id`, [c])).toHaveLength(1)
    expect((await as(editor, `select public.community_role($1) as r`, [c]))[0].r).toBeNull()
    expect(await as(editor, `update public.communities set description = 'hijack' where id = $1 returning id`, [c])).toHaveLength(0)
    const h = (await as(owner, `select public.org_activity($1) as h`, [org]))[0].h
    expect(h.map((x: any) => x.action)).toContain('org.community_added')
    expect((await as(owner, `select public.org_overview($1) as o`, [org]))[0].o.communities).toBe(2)
    await as(owner, `select public.set_community_organization($1, null)`, [c])                   // the organisation can let go of it
    expect((await as(owner, `select public.community_role($1) as r`, [c]))[0].r).toBeNull()
  })

  it('each member sets their own notification preferences for the organisation; unknown keys are refused', async () => {
    ev = (await as(editor, `insert into public.events (host, title, starts_at, organization_id) values (auth.uid(), 'Low tide', now() + interval '1 day', $1) returning id`, [org]))[0].id
    await as(editor, `select public.set_org_notif_prefs($1, '{"rsvps": true}'::jsonb)`, [org])
    await as(adminM, `select public.set_org_notif_prefs($1, '{"rsvps": false}'::jsonb)`, [org])
    await fails(editor, `select public.set_org_notif_prefs($1, '{"everything": true}'::jsonb)`, [org])
    await fails(editor, `select public.set_org_notif_prefs($1, '{"rsvps": "yes"}'::jsonb)`, [org])
    await fails(member, `select public.set_org_notif_prefs($1, '{"rsvps": true}'::jsonb)`, [org])
    await fails(editor, `update public.organization_members set notif_prefs = '{}' where user_id = auth.uid()`)   // no direct writes
    await as(member, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [ev])
    expect(await notes(editor, 'org_rsvp')).toBe(1)     // opted in
    expect(await notes(owner, 'org_rsvp')).toBe(1)      // default on
    expect(await notes(adminM, 'org_rsvp')).toBe(0)     // opted out
  })

  it('a new follower notifies owners and admins; editors only when they opt in', async () => {
    await as(member, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [org])
    expect(await notes(owner, 'org_follow')).toBe(1)
    expect(await notes(editor, 'org_follow')).toBe(0)
  })

  it('library: assets are private to their owner, shared with the organisation when filed there; status is server-only', async () => {
    const mine = `${member}/clip.mp4`, orgFile = `${editor}/poster.jpg`, orgThumb = `${editor}/poster-thumb.webp`
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1), ('media', $2), ('media', $3)`, [mine, orgFile, orgThumb])
    const a = (await as(member, `insert into public.media_assets (path, kind, mime, bytes) values ($1, 'video', 'video/mp4', 1000) returning id, status, owner`, [mine]))[0]
    expect(a.status).toBe('uploaded'); expect(a.owner).toBe(member)
    expect(await as(outsider, `select id from public.media_assets where id = $1`, [a.id])).toHaveLength(0)
    await fails(member, `update public.media_assets set status = 'ready' where id = $1`, [a.id])                         // only the worker
    await fails(member, `insert into public.media_assets (path, kind, mime, bytes, status) values ($1, 'video', 'video/mp4', 1, 'ready')`, [`${member}/x.mp4`])
    await fails(member, `insert into public.media_assets (path, kind, mime, bytes) values ($1, 'image', 'image/png', 1)`, [`${outsider}/theirs.png`])   // not your file
    await fails(member, `insert into public.media_assets (path, kind, mime, bytes, organization_id) values ($1, 'image', 'image/png', 1, $2)`, [`${member}/o.png`, org])   // not in the organisation
    const o = (await as(editor, `insert into public.media_assets (path, kind, mime, bytes, thumb_path, organization_id) values ($1, 'image', 'image/jpeg', 2000, $2, $3) returning id`, [orgFile, orgThumb, org]))[0].id
    expect(await as(owner, `select id from public.media_assets where id = $1`, [o])).toHaveLength(1)
    expect(await as(owner, `select 1 from storage.objects where name = $1`, [orgFile])).toHaveLength(1)                // org members read the file
    expect(await as(owner, `select 1 from storage.objects where name = $1`, [orgThumb])).toHaveLength(1)
    expect(await as(member, `select 1 from storage.objects where name = $1`, [orgFile])).toHaveLength(0)                  // not in the organisation
    expect(await as(editor, `select 1 from storage.objects where name = $1`, [mine])).toHaveLength(0)                   // personal stays personal
    await asServer(`update public.media_assets set status = 'ready', width = 800, height = 600 where id = $1`, [o])     // the worker
    expect((await as(editor, `select status from public.media_assets where id = $1`, [o]))[0].status).toBe('ready')
    expect(await as(member, `delete from public.media_assets where id = $1 returning id`, [o])).toHaveLength(0)
    expect(await as(adminM, `delete from public.media_assets where id = $1 returning id`, [o])).toHaveLength(1)        // org admin tidies up
  })

  it('a post video can carry a poster from the author\'s own folder only', async () => {
    const p = (await as(member, `insert into public.posts (author, body) values (auth.uid(), 'clip') returning id`))[0].id
    await fails(member, `insert into public.post_media (post_id, sort, path, type, poster_path) values ($1, 0, $2, 'video', $3)`, [p, `${member}/v.mp4`, `${outsider}/p.jpg`])
    await as(member, `insert into public.post_media (post_id, sort, path, type, poster_path) values ($1, 0, $2, 'video', $3)`, [p, `${member}/v.mp4`, `${member}/p.jpg`])
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${member}/p.jpg`])
    expect(await as(owner, `select 1 from storage.objects where name = $1`, [`${member}/p.jpg`])).toHaveLength(1)
  })
})

describe('migration 21: advisor fixes', () => {
  it('trigger functions cannot be called over the API; triggers still fire', async () => {
    const [a] = (await db.query<{ id: string }>(`select id from public.profiles order by username limit 1`)).rows.map(r => r.id)
    await fails(a, `select public.trg_friendship_lock()`)
    await fails(null, `select public.handle_new_user()`)
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`)).rows[0].n
    expect(n).toBe(0)
  })
  it('trg_friendship_lock has a fixed search_path', async () => {
    const r = (await db.query<{ c: string[] }>(`select proconfig as c from pg_proc where proname = 'trg_friendship_lock'`)).rows[0].c
    expect(r).toEqual(['search_path=""'])
  })
  it('no policy in public evaluates auth.uid() per row any more', async () => {
    const r = (await db.query<{ n: number }>(`select count(*)::int as n from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relnamespace = 'public'::regnamespace
      and (pg_get_expr(pol.polqual, pol.polrelid) ~ '(?<!SELECT )auth\\.uid\\(\\)' or pg_get_expr(pol.polwithcheck, pol.polrelid) ~ '(?<!SELECT )auth\\.uid\\(\\)')`)).rows[0].n
    expect(r).toBe(0)
  })
  it('every foreign key in public has a covering index', async () => {
    const r = (await db.query<{ n: number }>(`select count(*)::int as n from pg_constraint con join pg_class cls on cls.oid = con.conrelid
      where con.contype = 'f' and cls.relnamespace = 'public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid = con.conrelid
      and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey)`)).rows[0].n
    expect(r).toBe(0)
  })
})

describe('onboarding writes (a newly confirmed member)', () => {
  let u = ''
  it('setup', async () => {
    u = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('onb@example.com', '{"username":"onbnew"}') returning id`)).rows[0].id
  })
  it('the old upsert of private facts is refused by the column grant (what blocked onboarding)', async () => {
    await fails(u, `insert into public.profile_private (user_id, birth_date, terms_accepted_at) values (auth.uid(), '2000-01-01', now()) on conflict (user_id) do update set user_id = excluded.user_id, birth_date = excluded.birth_date, terms_accepted_at = excluded.terms_accepted_at`)
  })
  it('insert then update works, and every onboarding step can be saved', async () => {
    await as(u, `insert into public.profile_private (user_id, birth_date, terms_accepted_at) values (auth.uid(), '2000-01-01', now())`)
    expect(await as(u, `update public.profile_private set birth_date = '2001-02-02' where user_id = auth.uid() returning user_id`)).toHaveLength(1)
    await as(u, `update public.profiles set display_name = 'Onb', intents = '{meet_people}', onboarding_step = 1 where id = auth.uid()`)
    await as(u, `update public.profiles set bio = 'hi', onboarding_step = 2 where id = auth.uid()`)
    await as(u, `update public.profiles set location = 'Thohoyandou', country = 'South Africa', lat = -22.9, lng = 30.5, onboarding_step = 3 where id = auth.uid()`)
    await as(u, `update public.profiles set interests = '{Music}', onboarding_step = 4 where id = auth.uid()`)
    await as(u, `update public.profiles set dm_policy = 'friends', notif_prefs = '{}', onboarding_step = 6 where id = auth.uid()`)
    await as(u, `update public.profiles set onboarded_at = now(), onboarding_step = 6 where id = auth.uid()`)
    expect((await as(u, `select (public.my_profile() ->> 'onboarded_at') is not null as done`))[0].done).toBe(true)
  })
})

describe('migration 22: music uploads, live notifications, reels, video notes, usernames', () => {
  let host = '', friend = '', fan = '', stranger = '', admin = '', newbie = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => {
    host = await mk('m22host'); friend = await mk('m22friend'); fan = await mk('m22fan'); stranger = await mk('m22stranger'); admin = await mk('m22admin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    await as(host, `insert into public.friendships (requester, addressee) values (auth.uid(), $1)`, [friend])
    await as(friend, `update public.friendships set status = 'accepted' where addressee = auth.uid()`)
    await as(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [host])
  })

  it('admins can upload music artwork and previews again; members cannot', async () => {
    const art = `music/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}.png`, mp3 = `music/${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}.mp3`
    await as(admin, `insert into storage.objects (bucket_id, name) values ('brand', $1), ('brand', $2)`, [art, mp3])
    await fails(host, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`music/${'3'.repeat(8)}-3333-4333-8333-${'3'.repeat(12)}.mp3`])
    await fails(admin, `insert into storage.objects (bucket_id, name) values ('brand', 'music/evil.html')`)
  })

  it('going live yourself notifies friends and followers, not strangers', async () => {
    const s = (await asServer(`insert into public.live_streams (host, title, status, visibility) values ($1, 'Late night set', 'scheduled', 'public') returning id, room`, [host]))[0]
    await asServer(`select public.live_apply_event($1, 'room_started')`, [s.room])
    const got = async (u: string) => (await asServer(`select 1 from public.notifications where user_id = $1 and type = 'live_started' and entity_id = $2`, [u, s.id])).length
    expect(await got(friend)).toBe(1)
    expect(await got(fan)).toBe(1)
    expect(await got(stranger)).toBe(0)
    expect(await got(host)).toBe(0)
  })

  it('a friends-only live tells friends only', async () => {
    const s = (await asServer(`insert into public.live_streams (host, title, status, visibility) values ($1, 'Just us', 'scheduled', 'friends') returning id, room`, [host]))[0]
    await asServer(`select public.live_apply_event($1, 'room_started')`, [s.room])
    const got = async (u: string) => (await asServer(`select 1 from public.notifications where user_id = $1 and type = 'live_started' and entity_id = $2`, [u, s.id])).length
    expect(await got(friend)).toBe(1)
    expect(await got(fan)).toBe(0)
  })

  it('a reel must be a video post', async () => {
    await fails(host, `insert into public.posts (author, body, is_reel) values (auth.uid(), 'no video', true)`)
    const r = await as(host, `insert into public.posts (author, body, is_reel, media_path, media_type) values (auth.uid(), 'clip', true, $1, 'video') returning id`, [`${host}/r.mp4`])
    expect(r).toHaveLength(1)
    expect(await as(stranger, `select id from public.posts where is_reel and id = $1`, [r[0].id])).toHaveLength(1)
  })

  it('video note comments: own folder only, readable with the post', async () => {
    const p = (await as(host, `insert into public.posts (author, body) values (auth.uid(), 'hello') returning id`))[0].id
    await fails(friend, `insert into public.comments (post_id, author, body, video_path, video_ms) values ($1, auth.uid(), '', $2, 4000)`, [p, `${host}/theirs.webm`])
    await as(friend, `insert into public.comments (post_id, author, body, video_path, video_ms) values ($1, auth.uid(), '', $2, 4000)`, [p, `${friend}/note.webm`])
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${friend}/note.webm`])
    expect(await as(stranger, `select 1 from storage.objects where name = $1`, [`${friend}/note.webm`])).toHaveLength(1)
    await fails(friend, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), '')`, [p])   // empty comment still refused
  })

  it('choose a username during onboarding only; taken and reserved names are refused', async () => {
    newbie = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ('g@example.com', '{"full_name":"Thandi Mokoena"}') returning id`)).rows[0].id
    const p = (await as(newbie, `select public.my_profile() as p`))[0].p
    expect(p.username).toMatch(/^user_/); expect(p.display_name).toBe('Thandi Mokoena')
    await fails(newbie, `select public.set_username('m22host')`)
    await fails(newbie, `select public.set_username('admin')`)
    await fails(newbie, `select public.set_username('no spaces')`)
    expect((await as(newbie, `select public.set_username('Thandi_M') as u`))[0].u).toBe('thandi_m')
    await as(newbie, `update public.profiles set onboarded_at = now() where id = auth.uid()`)
    await fails(newbie, `select public.set_username('thandi_2')`)
  })

  it('signed-out visitors can ask whether a username is free (yes/no only)', async () => {
    expect((await as(null, `select public.username_available('m22host') as ok`))[0].ok).toBe(false)
    expect((await as(null, `select public.username_available('brand_new_name') as ok`))[0].ok).toBe(true)
    expect((await as(null, `select public.username_available('admin') as ok`))[0].ok).toBe(false)
  })
  it('login attempts are invisible to browser roles', async () => {
    await fails(host, `select * from public.login_attempts`)
    await fails(null, `insert into public.login_attempts (ip_hash, username, ok) values ('abcdefgh', 'x', false)`)
  })
})

describe('migration 23: event background media and Discover tile covers', () => {
  let host = '', other = '', admin = '', ev = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`

  it('setup', async () => {
    host = await mk('m23host'); other = await mk('m23other'); admin = await mk('m23admin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    ev = (await as(host, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Sunset beach braai', now() + interval '1 day') returning id`))[0].id
  })

  it('the cover and background video must be your own upload', async () => {
    await fails(host, `update public.events set cover_path = $2 where id = $1`, [ev, `${other}/${uuid('a')}.jpg`])
    await fails(host, `insert into public.events (host, title, starts_at, cover_path) values (auth.uid(), 'X', now() + interval '1 day', $1)`, [`${other}/${uuid('a')}.jpg`])
    await as(host, `update public.events set cover_path = $2, hero_video_path = $3 where id = $1`, [ev, `${host}/${uuid('b')}.webp`, `${host}/${uuid('c')}.mp4`])
    await fails(host, `update public.events set hero_video_path = $2 where id = $1`, [ev, `${host}/${uuid('d')}.html`])
    expect((await as(host, `select hero_video_path from public.events where id = $1`, [ev]))[0].hero_video_path).toBe(`${host}/${uuid('c')}.mp4`)
  })

  it('everyone who can see the event can load its background video', async () => {
    await db.exec(`reset role`)
    await db.query(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${host}/${uuid('c')}.mp4`])
    expect(await as(other, `select 1 from storage.objects where name = $1`, [`${host}/${uuid('c')}.mp4`])).toHaveLength(1)
  })

  it('only admins set Discover tile covers; everyone signed in reads them', async () => {
    const path = `discover/${uuid('e')}.webp`
    await as(admin, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [path])
    await fails(host, `insert into storage.objects (bucket_id, name) values ('brand', $1)`, [`discover/${uuid('f')}.webp`])
    await as(admin, `insert into public.discover_tiles (id, media_path) values ('music', $1)`, [path])
    await fails(admin, `insert into public.discover_tiles (id, media_path) values ('things', 'https://evil.example/x.png')`)
    await fails(host, `insert into public.discover_tiles (id, media_path) values ('things', $1)`, [path])
    expect(await as(host, `update public.discover_tiles set media_path = null where id = 'music' returning id`)).toHaveLength(0)
    expect((await as(host, `select media_path from public.discover_tiles where id = 'music'`))[0].media_path).toBe(path)
    await fails(null, `select * from public.discover_tiles`)
  })
})

describe('migration 24: guests on stage in a live', () => {
  let host = '', guest = '', other = '', sid = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => {
    host = await mk('m24host'); guest = await mk('m24guest'); other = await mk('m24other')
    sid = (await asServer(`insert into public.live_streams (host, title, status, visibility) values ($1, 'Group live', 'live', 'public') returning id`, [host]))[0].id
  })

  it('only the host puts people on stage; a viewer cannot invite themselves', async () => {
    await fails(guest, `select public.live_guest_set($1, auth.uid(), true)`, [sid])
    await fails(other, `select public.live_guest_set($1, $2, true)`, [sid, guest])
    await fails(guest, `insert into public.live_guests (stream_id, user_id) values ($1, auth.uid())`, [sid])
    expect((await as(host, `select public.live_guest_set($1, $2, true) as n`, [sid, guest]))[0].n).toBe(1)
  })

  it('an approved guest gets the guest role from the token gate; others stay viewers', async () => {
    expect((await as(guest, `select public.live_token_gate($1, false) as g`, [sid]))[0].g.role).toBe('guest')
    expect((await as(other, `select public.live_token_gate($1, false) as g`, [sid]))[0].g.role).toBe('viewer')
    await fails(guest, `select public.live_token_gate($1, true)`, [sid])                     // still cannot take the host's place
  })

  it('the guest list is visible to the host and the guest only', async () => {
    expect(await as(host, `select user_id from public.live_guests where stream_id = $1`, [sid])).toHaveLength(1)
    expect(await as(guest, `select user_id from public.live_guests where stream_id = $1`, [sid])).toHaveLength(1)
    expect(await as(other, `select user_id from public.live_guests where stream_id = $1`, [sid])).toHaveLength(0)
  })

  it('at most three guests', async () => {
    const extra = [await mk('m24g2'), await mk('m24g3'), await mk('m24g4')]
    await as(host, `select public.live_guest_set($1, $2, true)`, [sid, extra[0]])
    await as(host, `select public.live_guest_set($1, $2, true)`, [sid, extra[1]])
    await fails(host, `select public.live_guest_set($1, $2, true)`, [sid, extra[2]])
    await as(host, `select public.live_guest_set($1, $2, false)`, [sid, extra[1]])
    await as(host, `select public.live_guest_set($1, $2, false)`, [sid, extra[0]])
  })

  it('a guest can step down; a banned person loses the stage and cannot be invited again', async () => {
    await as(guest, `select public.live_guest_leave($1)`, [sid])
    expect((await as(guest, `select public.live_token_gate($1, false) as g`, [sid]))[0].g.role).toBe('viewer')
    await as(host, `select public.live_guest_set($1, $2, true)`, [sid, guest])
    await as(host, `select public.ban_from_stream($1, $2)`, [sid, guest])
    expect(await as(host, `select 1 from public.live_guests where stream_id = $1 and user_id = $2`, [sid, guest])).toHaveLength(0)
    await fails(host, `select public.live_guest_set($1, $2, true)`, [sid, guest])
  })

  it('nobody goes on stage in an ended stream', async () => {
    await asServer(`update public.live_streams set status = 'ended' where id = $1`, [sid])
    await fails(host, `select public.live_guest_set($1, $2, true)`, [sid, other])
  })
})

describe('migration 25: photo display copies, media path indexes, field performance numbers', () => {
  let alice = '', bob = '', carol = '', admin = '', pub = '', priv = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const sample = (o: Record<string, unknown> = {}) => ({ n: 'lcp', v: 1830, r: 'home', c: '4g', m: 'auto', d: 'phone', ...o })

  it('setup', async () => {
    alice = await mk('m25alice'); bob = await mk('m25bob'); carol = await mk('m25carol'); admin = await mk('m25admin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    pub = (await as(alice, `insert into public.posts (author, body, visibility) values (auth.uid(), 'photo', 'public') returning id`))[0].id
    priv = (await as(alice, `insert into public.posts (author, body, visibility) values (auth.uid(), 'photo', 'friends') returning id`))[0].id
  })

  it('a display copy must be the author’s own file (and, since migration 35, a video’s copy must be a video)', async () => {
    await as(alice, `insert into public.post_media (post_id, sort, path, type, display_path) values ($1, 0, $2, 'image', $3)`, [pub, `${alice}/p.jpg`, `${alice}/p-d.webp`])
    await as(alice, `insert into public.post_media (post_id, sort, path, type, display_path) values ($1, 0, $2, 'image', $3)`, [priv, `${alice}/q.jpg`, `${alice}/q-d.webp`])
    await fails(alice, `insert into public.post_media (post_id, sort, path, type, display_path) values ($1, 1, $2, 'image', $3)`, [pub, `${alice}/r.jpg`, `${bob}/stolen.webp`])
    await fails(alice, `insert into public.post_media (post_id, sort, path, type, display_path) values ($1, 1, $2, 'video', $3)`, [pub, `${alice}/v.mp4`, `${alice}/v-d.webp`])
    await fails(bob, `insert into public.post_media (post_id, sort, path, type, display_path) values ($1, 2, $2, 'image', $3)`, [pub, `${bob}/x.jpg`, `${bob}/x-d.webp`])
  })

  it('a display copy is readable exactly when its post is', async () => {
    await asServer(`insert into storage.objects (bucket_id, name) select 'media', x from unnest(array[$1, $2]) x where not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = x)`, [`${alice}/p-d.webp`, `${alice}/q-d.webp`])
    const read = (u: string | null, path: string) => as(u, `select name from storage.objects where bucket_id = 'media' and name = $1`, [path])
    expect(await read(bob, `${alice}/p-d.webp`)).toHaveLength(1)                 // public post
    expect(await read(bob, `${alice}/q-d.webp`)).toHaveLength(0)                 // friends-only post, not friends
    expect(await read(alice, `${alice}/q-d.webp`)).toHaveLength(1)
    await expect(read(null, `${alice}/p-d.webp`)).rejects.toThrow()             // signed out: no access at all
  })

  it('every file path the media read rule looks up is indexed', async () => {
    const idx = (await asServer(`select indexname from pg_indexes where schemaname = 'public'`)).map((r: any) => r.indexname)
    for (const i of ['posts_media_path_idx', 'posts_music_path_idx', 'post_media_path_idx', 'post_media_poster_path_idx', 'post_media_display_path_idx',
      'comments_audio_path_idx', 'comments_video_path_idx', 'profiles_avatar_path_idx', 'profiles_cover_path_idx', 'events_cover_path_idx',
      'events_hero_video_path_idx', 'event_lineup_image_path_idx', 'communities_cover_path_idx', 'memories_media_path_idx',
      'memory_replies_audio_path_idx', 'messages_media_path_idx', 'messages_audio_path_idx', 'messages_file_path_idx',
      'organizations_avatar_path_idx', 'organizations_cover_path_idx', 'media_assets_org_path_idx', 'media_assets_org_thumb_path_idx']) expect(idx).toContain(i)
  })

  it('performance numbers: signed-in only, valid samples only, no way to read them back', async () => {
    await fails(null, `select public.record_client_metrics($1)`, [JSON.stringify([sample()])])
    const bad = [sample({ v: 'abc' }), sample({ v: -1 }), sample({ n: 'password' }), sample({ r: '/app/u/alice' }), sample({ v: 1e9 }), { n: 'lcp' }, 'x']
    expect((await as(bob, `select public.record_client_metrics($1) as k`, [JSON.stringify([sample(), sample({ n: 'cls', v: 0.04 }), ...bad])]))[0].k).toBe(2)
    expect((await as(bob, `select public.record_client_metrics($1) as k`, [JSON.stringify({ n: 'lcp' })]))[0].k).toBe(0)
    await fails(bob, `select * from public.client_metrics`)
    await fails(bob, `insert into public.client_metrics (name, value, route, net, mode, device) values ('lcp', 1, 'home', '4g', 'auto', 'phone')`)
    await fails(bob, `select * from public.client_metric_quota`)
    const cols = (await asServer(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'client_metrics'`)).map((r: any) => r.column_name)
    expect(cols).not.toContain('user_id')                                         // anonymous by design
  })

  it('at most 30 samples a call and 300 a day per person', async () => {
    expect((await as(carol, `select public.record_client_metrics($1) as k`, [JSON.stringify(Array.from({ length: 50 }, () => sample()))]))[0].k).toBe(30)
    for (let i = 0; i < 9; i++) await as(carol, `select public.record_client_metrics($1)`, [JSON.stringify(Array.from({ length: 30 }, () => sample()))])
    expect((await as(carol, `select public.record_client_metrics($1) as k`, [JSON.stringify([sample()])]))[0].k).toBe(0)
  })

  it('percentiles for admins only', async () => {
    await fails(bob, `select * from public.client_metrics_summary(7)`)
    const rows = await as(admin, `select * from public.client_metrics_summary(7) where name = 'cls'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ route: 'home', mode: 'auto' })
    expect(Number(rows[0].p75)).toBeCloseTo(0.04, 3)
  })
})

describe('migration 26: memory studio, close friends, reel settings, song lengths', () => {
  let alice = '', bob = '', carol = '', dave = '', admin = '', track = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }

  it('setup', async () => {
    alice = await mk('m26alice'); bob = await mk('m26bob'); carol = await mk('m26carol'); dave = await mk('m26dave'); admin = await mk('m26admin')
    await db.query(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin])
    await db.query(`insert into public.friendships (requester, addressee, status) values ($1, $2, 'accepted'), ($1, $3, 'accepted')`, [alice, bob, carol])
    await db.query(`insert into public.blocks (blocker, blocked) values ($1, $2)`, [alice, dave])
    const u = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    track = (await as(admin, `insert into public.music_tracks (title, artist, preview_path, duration_ms) values ('Golden', 'Nala', 'music/${u}.mp3', 194000) returning id`))[0].id
  })

  it('close friends: only the owner sees or changes the list; blocked people cannot be added', async () => {
    await as(alice, `insert into public.close_friends (owner, friend) values (auth.uid(), $1)`, [bob])
    await fails(alice, `insert into public.close_friends (owner, friend) values (auth.uid(), auth.uid())`)
    await fails(alice, `insert into public.close_friends (owner, friend) values (auth.uid(), $1)`, [dave])
    await fails(bob, `insert into public.close_friends (owner, friend) values ($1, $2)`, [alice, carol])
    expect(await as(bob, `select 1 from public.close_friends`)).toHaveLength(0)                // the people on it are never told
    expect(await as(alice, `select friend from public.close_friends`)).toEqual([{ friend: bob }])
    expect(await as(bob, `delete from public.close_friends returning 1`)).toHaveLength(0)
  })

  it('a close-friends memory with a song, overlays and a filter is visible to the list only', async () => {
    const overlays = JSON.stringify([{ t: 'text', id: 'a', text: 'Graduated!', x: 0.5, y: 0.3 }, { t: 'mention', id: 'b', uid: bob, username: 'm26bob', x: 0.5, y: 0.6 }])
    const m = (await as(alice, `insert into public.memories (author, kind, media_path, visibility, music_track_id, music_title, music_artist, music_start_ms, overlays, filter)
      values (auth.uid(), 'photo', $1, 'close_friends', $2, 'Golden', 'Nala', 30000, $3, 'warm') returning id`, [`${alice}/grad.jpg`, track, overlays]))[0].id
    const see = async (u: string) => (await as(u, `select id from public.memories where id = $1`, [m])).length
    expect(await see(alice)).toBe(1); expect(await see(bob)).toBe(1); expect(await see(carol)).toBe(0); expect(await see(dave)).toBe(0)
    const got = ((await as(bob, `select public.author_memories($1) as m`, [alice]))[0].m as any[]).find(x => x.id === m)
    expect(got).toMatchObject({ visibility: 'close_friends', music_title: 'Golden', music_start_ms: 30000, filter: 'warm', music_preview_path: expect.stringMatching(/^music\//) })
    expect(got.overlays).toHaveLength(2)
    await as(alice, `delete from public.close_friends where friend = $1`, [bob])
    expect(await see(bob)).toBe(0)                                                              // off the list: gone at once
  })

  it('memory studio fields reject nonsense', async () => {
    await fails(alice, `insert into public.memories (author, kind, text_body, filter) values (auth.uid(), 'text', 'x', 'sepia-hack')`)
    await fails(alice, `insert into public.memories (author, kind, text_body, overlays) values (auth.uid(), 'text', 'x', '{"t":"text"}')`)              // must be a list
    await fails(alice, `insert into public.memories (author, kind, text_body, overlays) values (auth.uid(), 'text', 'x', $1)`, [JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ t: 'text', id: String(i) })))])
    await fails(alice, `insert into public.memories (author, kind, text_body, music_path, music_title) values (auth.uid(), 'text', 'x', $1, 'Mine')`, [`${bob}/song.mp3`])   // someone else's file
    await fails(alice, `insert into public.memories (author, kind, text_body, music_path) values (auth.uid(), 'text', 'x', $1)`, [`${alice}/song.mp3`])                   // a song needs a name
    await fails(alice, `insert into public.memories (author, kind, text_body, visibility) values (auth.uid(), 'text', 'x', 'everyone')`)
  })

  it('a song from the member’s device is readable exactly when the memory is', async () => {
    await as(alice, `insert into public.memories (author, kind, text_body, visibility, music_path, music_title, music_artist) values (auth.uid(), 'text', 'Vibes', 'friends', $1, 'My mix', 'Me')`, [`${alice}/mix.mp3`])
    await asServer(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${alice}/mix.mp3`])
    const read = (u: string) => as(u, `select name from storage.objects where bucket_id = 'media' and name = $1`, [`${alice}/mix.mp3`])
    expect(await read(bob)).toHaveLength(1)
    expect(await read(dave)).toHaveLength(0)
    const idx = (await asServer(`select indexname from pg_indexes where schemaname = 'public'`)).map((r: any) => r.indexname)
    expect(idx).toContain('memories_music_path_idx')
  })

  it('reel settings are a small object; song lengths come back from the catalogue and trending counts memories', async () => {
    const edit = JSON.stringify({ filter: 'vivid', speed: 2, trim: [500, 9000], ov: 0.4, mv: 1, ms: 12000 })
    await as(bob, `insert into public.posts (author, body, media_path, media_type, visibility, is_reel, reel_edit) values (auth.uid(), 'Run', $1, 'video', 'public', true, $2)`, [`${bob}/r.mp4`, edit])
    await fails(bob, `insert into public.posts (author, body, media_path, media_type, is_reel, reel_edit) values (auth.uid(), 'x', $1, 'video', true, '[1,2]')`, [`${bob}/r2.mp4`])
    await fails(bob, `insert into public.posts (author, body, media_path, media_type, is_reel, reel_edit) values (auth.uid(), 'x', $1, 'video', true, $2)`, [`${bob}/r3.mp4`, JSON.stringify({ junk: 'x'.repeat(4000) })])
    await fails(admin, `insert into public.music_tracks (title, artist, duration_ms) values ('x', 'y', 5)`)
    const cat = ((await as(carol, `select public.music_catalog('trending') as c`))[0].c as { id: string; duration_ms: number | null }[])
    expect(cat[0]).toMatchObject({ id: track, duration_ms: 194000 })                          // used in alice's memory
  })
})

describe('migration 27: suggestions in the feed (events, artists, people)', () => {
  let me = '', friend = '', host = '', stranger = '', blocked = '', artistOwner = ''
  let evFriends = '', evNear = '', evMine = '', evBlocked = '', evFriendsOnly = '', evPast = '', evSaved = '', evPrivateRsvp = '', evMusic = ''
  let artist = '', otherArtist = '', venue = ''
  const mk = async (n: string, interests: string[] = []) => {
    const id = (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id
    await db.query(`update public.profiles set onboarded_at = now(), interests = $2 where id = $1`, [id, interests])
    return id
  }
  const asServer = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query(sql, params)).rows }
  const sugg = async (u: string, lat: number | null = null, lng: number | null = null) => (await as(u, `select public.feed_suggestions($1, $2, 20) as s`, [lat, lng]))[0].s
  const befriend = async (a: string, b: string) => {
    const f = (await as(a, `insert into public.friendships (requester, addressee) values (auth.uid(), $1) returning id`, [b]))[0].id
    await as(b, `update public.friendships set status = 'accepted' where id = $1`, [f])
  }
  const event = async (h: string, title: string, extra = '', when = "now() + interval '3 days'") =>
    (await as(h, `insert into public.events (host, title, starts_at${extra ? ', ' + extra.split('=')[0] : ''}) values (auth.uid(), $1, ${when}${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [title]))[0].id

  it('setup', async () => {
    me = await mk('m27me', ['Music']); friend = await mk('m27friend'); host = await mk('m27host'); stranger = await mk('m27stranger', ['Music', 'Art'])
    blocked = await mk('m27blocked'); artistOwner = await mk('m27artist')
    await befriend(me, friend)
    evFriends = await event(host, 'Friends are going')
    evNear = await asServer(`insert into public.events (host, title, starts_at, lat, lng, city) values ($1, 'Around the corner', now() + interval '20 days', -33.92, 18.42, 'Cape Town') returning id`, [host]).then(r => r[0].id)
    evMine = await event(me, 'My own event')
    evBlocked = await event(blocked, 'From someone I blocked')
    evFriendsOnly = await event(stranger, 'Friends only', "visibility='friends'")
    evPast = await event(host, 'Already over', '', "now() - interval '3 days'")
    evSaved = await event(host, 'Already saved')
    evPrivateRsvp = await event(host, 'Friend going privately')
    evMusic = await asServer(`insert into public.events (host, title, starts_at, category) values ($1, 'A gig', now() + interval '30 days', 'concerts') returning id`, [host]).then(r => r[0].id)
    await as(friend, `insert into public.event_rsvps (event_id, user_id, status, visibility) values ($1, auth.uid(), 'going', 'friends')`, [evFriends])
    await as(friend, `insert into public.event_rsvps (event_id, user_id, status, visibility) values ($1, auth.uid(), 'going', 'private')`, [evPrivateRsvp])
    await as(me, `insert into public.event_saves (user_id, event_id) values (auth.uid(), $1)`, [evSaved])
    await as(me, `insert into public.blocks (blocker, blocked) values (auth.uid(), $1)`, [blocked])
    artist = (await as(artistOwner, `insert into public.organizations (name, slug, kind, created_by) values ('The Night Owls', 'night-owls', 'artist', auth.uid()) returning id`))[0].id
    otherArtist = (await as(artistOwner, `insert into public.organizations (name, slug, kind, created_by) values ('Quiet Creator', 'quiet-creator', 'creator', auth.uid()) returning id`))[0].id
    venue = (await as(artistOwner, `insert into public.organizations (name, slug, kind, created_by) values ('Big Venue', 'big-venue', 'venue', auth.uid()) returning id`))[0].id
  })

  it('signed out: nothing', async () => {
    await fails(null, `select public.feed_suggestions(null, null, 10)`)
    await fails(null, `select public.dismiss_suggestion('event', $1)`, [evNear])
  })

  it('events: friends going comes first with its reason; private RSVPs are never counted', async () => {
    const ev = (await sugg(me)).events
    expect(ev[0]).toMatchObject({ id: evFriends, reason: { code: 'friends_going', n: 1 }, friends_going: 1 })
    const priv = ev.find((e: any) => e.id === evPrivateRsvp)
    expect(priv?.friends_going).toBe(0)
    expect(priv?.reason.code).not.toBe('friends_going')
  })

  it('events: never my own, saved, past, blocked or invisible ones', async () => {
    const ids = (await sugg(me)).events.map((e: any) => e.id)
    for (const x of [evMine, evSaved, evPast, evBlocked, evFriendsOnly]) expect(ids).not.toContain(x)
    expect(ids).toContain(evNear)
  })

  it('events: interests and distance give reasons; far in-person events drop out when a location is shared', async () => {
    const ev = (await sugg(me)).events
    expect(ev.find((e: any) => e.id === evMusic)?.reason).toMatchObject({ code: 'your_interests', label: 'Concerts & gigs' })
    const near = (await sugg(me, -33.93, 18.42)).events
    expect(near.find((e: any) => e.id === evNear)?.reason).toMatchObject({ code: 'near_you' })
    const far = (await sugg(me, 51.5, -0.12)).events.map((e: any) => e.id)
    expect(far).not.toContain(evNear)
  })

  it('events: following the host, or an artist on the lineup', async () => {
    await as(me, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [host])
    expect((await sugg(me)).events.find((e: any) => e.id === evNear)?.reason.code).toBe('you_follow_host')
    await as(me, `delete from public.follows where follower = auth.uid() and target_id = $1`, [host])
    const followed = (await as(artistOwner, `insert into public.organizations (name, slug, kind, created_by) values ('Lineup Star', 'lineup-star', 'artist', auth.uid()) returning id`))[0].id
    await as(me, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [followed])
    await as(host, `insert into public.event_lineup (event_id, name) values ($1, 'Lineup Star')`, [evNear])
    expect((await sugg(me)).events.find((e: any) => e.id === evNear)?.reason).toMatchObject({ code: 'artist_you_follow', label: 'Lineup Star' })
  })

  it('artists: only artists and creators I do not follow; one playing an event I am going to says so', async () => {
    let ar = (await sugg(me)).artists
    expect(ar.map((a: any) => a.id)).toContain(artist)
    expect(ar.map((a: any) => a.id)).not.toContain(venue)
    expect(ar.find((a: any) => a.id === artist)?.reason).toMatchObject({ code: 'your_interests', label: 'Music' })
    await as(host, `insert into public.event_lineup (event_id, name) values ($1, 'The Night Owls')`, [evMusic])
    await as(me, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [evMusic])
    ar = (await sugg(me)).artists
    expect(ar[0]).toMatchObject({ id: artist, reason: { code: 'plays_your_event', label: 'A gig' } })
    expect((await sugg(me)).events.map((e: any) => e.id)).not.toContain(evMusic)          // going now: no longer suggested
    await as(me, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'organization', $1)`, [artist])
    expect((await sugg(me)).artists.map((a: any) => a.id)).not.toContain(artist)
    expect((await sugg(artistOwner)).artists.map((a: any) => a.id)).not.toContain(otherArtist) // their own page
  })

  it('people: not friends, not followed, not blocked; shared interests explained', async () => {
    const pe = (await sugg(me)).people
    const ids = pe.map((p: any) => p.id)
    expect(ids).not.toContain(friend); expect(ids).not.toContain(blocked); expect(ids).not.toContain(me)
    expect(pe.find((p: any) => p.id === stranger)?.reason).toMatchObject({ code: 'shared_interests', label: 'Music' })
  })

  it('"Not interested" is remembered, private, and only through the function', async () => {
    await as(me, `select public.dismiss_suggestion('event', $1)`, [evNear])
    await as(me, `select public.dismiss_suggestion('profile', $1)`, [stranger])
    await as(me, `select public.dismiss_suggestion('event', $1)`, [evNear])                       // twice is fine
    const s = await sugg(me)
    expect(s.events.map((e: any) => e.id)).not.toContain(evNear)
    expect(s.people.map((p: any) => p.id)).not.toContain(stranger)
    expect(await as(me, `select * from public.suggestion_dismissals`)).toHaveLength(2)
    expect(await as(friend, `select * from public.suggestion_dismissals`)).toHaveLength(0)
    await fails(me, `insert into public.suggestion_dismissals (user_id, kind, target_id) values (auth.uid(), 'event', $1)`, [evFriends])
    await fails(me, `select public.dismiss_suggestion('password', $1)`, [evFriends])
    await as(me, `delete from public.suggestion_dismissals where target_id = $1`, [evNear])         // undo
    expect((await sugg(me)).events.map((e: any) => e.id)).toContain(evNear)
  })
})

describe('migration 28: VYBE Tickets — fee policies, sales review, journal, reconciliation, admission, payouts', () => {
  let host = '', editor = '', buyer = '', buyer2 = '', scanner = '', stranger = '', admin = '', admin2 = '', org = '', ev = '', tt = '', freeTt = '', orgPolicy = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const order = (uid: string, items: { tt: string; qty: number }[], key = crypto.randomUUID()) =>
    as(uid, `select public.create_order($1, $2::jsonb, 'payfast', $3) as o`, [ev, JSON.stringify(items.map(i => ({ ticket_type_id: i.tt, qty: i.qty }))), key]).then(r => r[0].o)
  const pay = (o: { id: string; total_cents: number }, ref = 'pf-' + crypto.randomUUID()) => server(`select public.fulfill_order($1, 'payfast', $2, $3, 'cc')`, [o.id, ref, o.total_cents])
  const sumLines = async (where = 'true') => Number((await server(`select coalesce(sum(amount_cents), 0) as s from public.journal_lines where ${where}`))[0].s)

  it('setup: review gate and cooling-off back on; an organisation event with paid and free tickets', async () => {
    await server(`update public.platform_config set require_sales_review = true, payout_account_cooloff_hours = 72, vat_registered = false`)
    host = await mk('t27host'); editor = await mk('t27editor'); buyer = await mk('t27buyer'); buyer2 = await mk('t27buyer2'); scanner = await mk('t27scan')
    stranger = await mk('t27stranger'); admin = await mk('t27admin'); admin2 = await mk('t27admin2')
    await server(`insert into public.staff (user_id, role) values ($1, 'admin'), ($2, 'admin')`, [admin, admin2])
    org = (await as(host, `insert into public.organizations (name, slug, kind, created_by) values ('Night Co', 't27-night-co', 'organizer', auth.uid()) returning id`))[0].id
    await as(host, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'editor')`, [org, editor])
    await as(editor, `update public.organization_members set status = 'active' where user_id = auth.uid()`)
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, organization_id) values (auth.uid(), 'Graduation party', now() + interval '10 days', 'UTC', 'public', $1) returning id`, [org]))[0].id
    tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'GA', 15000, 3, 3) returning id`, [ev]))[0].id
    freeTt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'Guest list', 0, 50, 2) returning id`, [ev]))[0].id
  })

  it('pricing: the database and src/lib/pricing.ts agree, to the cent, on a spread of terms and amounts', async () => {
    const { priceOrder } = await import('../../src/lib/pricing')
    const terms = [
      { commission_bps: 500, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 },
      { commission_bps: 350, commission_fixed_cents: 100, commission_per_ticket_cents: 50, buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, buyer_fee_per_ticket_cents: 25 },
      { commission_bps: 3000, commission_fixed_cents: 100000, commission_per_ticket_cents: 0, buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 },
    ]
    for (const t of terms) for (const [sub, units] of [[0, 0], [1, 1], [999, 1], [15000, 1], [33333, 3], [4999999, 20]]) for (const vat of [false, true]) {
      const sql = (await as(admin, `select public.preview_pricing($1::jsonb, $2, $3) as p`, [JSON.stringify(t), sub, units]))[0].p
      if (vat) continue
      const ts = priceOrder(t, sub, units)
      for (const k of Object.keys(ts) as (keyof typeof ts)[]) expect([k, Number(sql[k])]).toEqual([k, ts[k]])
    }
    await server(`update public.platform_config set vat_registered = true, vat_number = '4000000001'`)
    for (const t of terms) for (const [sub, units] of [[15000, 1], [33333, 3], [4999999, 20]]) {
      const sql = (await as(admin, `select public.preview_pricing($1::jsonb, $2, $3) as p`, [JSON.stringify(t), sub, units]))[0].p
      const ts = priceOrder(t, sub, units, { registered: true, rate_bps: 1500 })
      for (const k of Object.keys(ts) as (keyof typeof ts)[]) expect([k, Number(sql[k])]).toEqual([k, ts[k]])
    }
    await server(`update public.platform_config set vat_registered = false, vat_number = null`)
    await expect(as(host, `select public.preview_pricing('{}'::jsonb, 100, 1)`)).rejects.toThrow(/forbidden/)
  })

  it('fee policies: launch terms seeded; versions are immutable; only admins write them, with a reason', async () => {
    const v1 = (await server(`select * from public.fee_policies where scope = 'platform' and name = 'Platform v1 (launch terms)'`))
    expect(v1).toHaveLength(1)
    expect(v1[0]).toMatchObject({ buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, commission_bps: 0 })
    await expect(server(`update public.fee_policies set commission_bps = 1 where id = $1`, [v1[0].id])).rejects.toThrow(/immutable/)
    await expect(server(`delete from public.fee_policies where id = $1`, [v1[0].id])).rejects.toThrow(/cannot be deleted/)
    await expect(as(host, `select public.admin_create_fee_policy('{"scope": "organization", "commission_bps": 0, "note": "free"}'::jsonb)`)).rejects.toThrow(/forbidden/)
    await expect(as(host, `insert into public.fee_policies (scope, name) values ('platform', 'mine')`)).rejects.toThrow()
    await expect(as(admin, `select public.admin_create_fee_policy($1::jsonb)`, [JSON.stringify({ scope: 'organization', organization_id: org, commission_bps: 500 })])).rejects.toThrow(/note/)
    await expect(as(admin, `select public.admin_create_fee_policy($1::jsonb)`, [JSON.stringify({ scope: 'organization', organization_id: org, commission_bps: 500, note: 'x', effective_from: '2020-01-01' })])).rejects.toThrow(/past/)
    orgPolicy = (await as(admin, `select public.admin_create_fee_policy($1::jsonb) as id`, [JSON.stringify({ scope: 'organization', organization_id: org, name: 'Night Co: 5% organiser commission', commission_bps: 500, buyer_fee_enabled: false, note: 'Signed contract #12' })]))[0].id
    expect((await as(host, `select id from public.fee_policies where id = $1`, [orgPolicy]))).toHaveLength(1)      // the organiser can see its own terms
    expect((await as(stranger, `select id from public.fee_policies`))).toHaveLength(0)
    expect((await as(editor, `select public.event_fee_terms($1) as t`, [ev]))[0].t).toMatchObject({ commission_bps: 500, buyer_fee_enabled: false, scope: 'organization' })
    await expect(as(stranger, `select public.event_fee_terms($1)`, [ev])).rejects.toThrow(/forbidden/)
  })

  it('sales review: paid tickets wait for approval; free tickets do not; the creator cannot pre-approve', async () => {
    await expect(order(buyer, [{ tt, qty: 1 }])).rejects.toThrow(/once VYBE has reviewed/)
    expect((await order(buyer, [{ tt: freeTt, qty: 1 }])).status).toBe('paid')
    const sneaky = (await as(host, `insert into public.events (host, title, starts_at, sales_review) values (auth.uid(), 'Sneaky', now() + interval '3 days', 'approved') returning sales_review`))[0]
    expect(sneaky.sales_review).toBe('not_submitted')                                                       // forced by the insert trigger
    await expect(as(host, `update public.events set sales_review = 'approved' where id = $1`, [ev])).rejects.toThrow()   // no column grant
    await expect(as(host, `select public.submit_event_for_sales_review($1)`, [ev])).rejects.toThrow(/evidence/)
    await expect(as(stranger, `select public.add_event_evidence($1, 'organiser_identity', 'me')`, [ev])).rejects.toThrow(/forbidden/)
    await expect(as(host, `select public.add_event_evidence($1, 'venue_authorisation', '', $2)`, [ev, `${stranger}/booking.pdf`])).rejects.toThrow()   // someone else's file
    await as(host, `select public.add_event_evidence($1, 'organiser_identity', 'Company reg 2020/123456/07')`, [ev])
    await as(editor, `select public.add_event_evidence($1, 'venue_authorisation', 'Booking confirmation from the venue manager', $2)`, [ev, `${editor}/booking.pdf`])
    expect(await as(stranger, `select 1 from public.event_evidence where event_id = $1`, [ev])).toHaveLength(0)
    await server(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [`${editor}/booking.pdf`])
    const read = (u: string) => as(u, `select 1 from storage.objects where bucket_id = 'media' and name = $1`, [`${editor}/booking.pdf`])
    expect(await read(admin)).toHaveLength(1); expect(await read(host)).toHaveLength(1); expect(await read(stranger)).toHaveLength(0)
    expect((await as(editor, `select public.submit_event_for_sales_review($1, 'Ready') as s`, [ev]))[0].s).toBe('submitted')
    await expect(as(editor, `select public.submit_event_for_sales_review($1)`, [ev])).rejects.toThrow(/already submitted/)
    await expect(order(buyer, [{ tt, qty: 1 }])).rejects.toThrow(/once VYBE has reviewed/)
  })

  it('sales review: explicit transitions, reasons for refusals, no reviewing your own event, every decision logged', async () => {
    await expect(as(host, `select public.admin_review_event_sales($1, 'approved')`, [ev])).rejects.toThrow(/forbidden/)
    await as(host, `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'editor')`, [org, admin2])
    await as(admin2, `update public.organization_members set status = 'active' where user_id = auth.uid() and organization_id = $1`, [org])
    await expect(as(admin2, `select public.admin_review_event_sales($1, 'approved')`, [ev])).rejects.toThrow(/belong to/)    // conflict of interest
    await expect(as(admin, `select public.admin_review_event_sales($1, 'suspended', 'x')`, [ev])).rejects.toThrow(/Cannot move/)
    await expect(as(admin, `select public.admin_review_event_sales($1, 'rejected', '')`, [ev])).rejects.toThrow(/reason/)
    await as(admin, `select public.admin_review_event_sales($1, 'under_review')`, [ev])
    await as(admin, `select public.admin_review_event_sales($1, 'approved', 'Venue confirmed by phone with the manager')`, [ev])
    const log = await as(host, `select from_status, to_status from public.event_sales_decisions where event_id = $1 order by id`, [ev])
    expect(log.map((r: any) => `${r.from_status}>${r.to_status}`)).toEqual(['not_submitted>submitted', 'submitted>under_review', 'under_review>approved'])
    expect((await as(host, `select type from public.notifications where type = 'sales_review'`)).length).toBeGreaterThanOrEqual(1)
  })

  it('an approved event sells under its organisation\'s terms, with an immutable pricing snapshot', async () => {
    const o = await order(buyer, [{ tt, qty: 1 }])
    const row = (await server(`select * from public.orders where id = $1`, [o.id]))[0]
    expect(Number(row.subtotal_cents)).toBe(15000); expect(Number(row.fee_cents)).toBe(0); expect(Number(row.total_cents)).toBe(15000)
    expect(Number(row.commission_cents)).toBe(750); expect(Number(row.organizer_net_cents)).toBe(14250); expect(row.fee_policy_id).toBe(orgPolicy)
    expect(row.pricing).toMatchObject({ policy_id: orgPolicy, commission_bps: 500, commission_base: 'ticket_subtotal', rounding: 'half_up_per_order', commission_cents: 750 })
    await pay(o)
    // New terms later never change an existing order.
    await as(admin, `select public.admin_create_fee_policy($1::jsonb)`, [JSON.stringify({ scope: 'event', event_id: ev, commission_bps: 300, note: 'Promo rate for this event' })])
    expect(Number((await server(`select commission_cents from public.orders where id = $1`, [o.id]))[0].commission_cents)).toBe(750)
    const o2 = await order(buyer2, [{ tt, qty: 1 }])
    expect(Number((await server(`select commission_cents from public.orders where id = $1`, [o2.id]))[0].commission_cents)).toBe(450)
    await pay(o2)
  })

  it('journal: each sale posts one balanced entry, a duplicate webhook posts nothing, lines are append-only', async () => {
    const lines = await server(`select account, amount_cents::int as a from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
                                where e.kind = 'sale' and e.event_id = $1 order by l.id`, [ev])
    expect(lines.slice(0, 3)).toEqual([{ account: 'platform_cash', a: 15000 }, { account: 'organizer_payable', a: -14250 }, { account: 'commission_revenue', a: -750 }])
    expect(await sumLines()).toBe(0)                                                                // the whole journal balances
    const before = Number((await server(`select count(*) as n from public.journal_entries`))[0].n)
    const o = (await server(`select id, total_cents from public.orders where event_id = $1 and status = 'paid' and total_cents > 0 limit 1`, [ev]))[0]
    await pay({ id: o.id, total_cents: Number(o.total_cents) })                                      // webhook delivered again
    expect(Number((await server(`select count(*) as n from public.journal_entries`))[0].n)).toBe(before)
    expect((await server(`select count(*)::int as n from public.tickets where order_id = $1`, [o.id]))[0].n).toBe(1)
    await expect(server(`update public.journal_lines set amount_cents = 1 where id = (select min(id) from public.journal_lines)`)).rejects.toThrow(/append-only/)
    await expect(server(`delete from public.journal_entries where id = (select min(id) from public.journal_entries)`)).rejects.toThrow(/append-only/)
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`)
    await expect(db.exec(`begin; select public.post_journal('adjustment', 'bad-entry', '{}'::jsonb, '[{"account":"adjustments","amount":100},{"account":"platform_cash","amount":-99}]'::jsonb); commit;`)).rejects.toThrow(/does not balance/)
    await db.exec(`rollback`).catch(() => {})
    expect((await server(`select 1 from public.journal_entries where idempotency_key = 'bad-entry'`))).toHaveLength(0)
    await expect(as(buyer, `select public.post_journal('adjustment', 'x', '{}'::jsonb, '[]'::jsonb)`)).rejects.toThrow()
    expect(await as(stranger, `select 1 from public.journal_lines`)).toHaveLength(0)
    expect((await as(host, `select distinct account from public.journal_lines`)).map((r: any) => r.account)).toEqual(['organizer_payable'])   // own payable only
  })

  it('reconciliation: a clean book has no exceptions; the organiser sub-ledger equals the journal', async () => {
    await expect(as(host, `select public.finance_reconcile()`)).rejects.toThrow(/forbidden/)
    await as(admin, `select public.finance_reconcile()`)
    const open = await as(admin, `select kind from public.reconciliation_exceptions where status = 'open' and kind not in ('payout_awaiting_approval')`)
    expect(open.filter((r: any) => ['journal_unbalanced', 'payable_mismatch', 'ticket_count_mismatch', 'missing_sale_journal'].includes(r.kind))).toEqual([])
    const sub = Number((await server(`select coalesce(sum(amount_cents), 0) as s from public.ledger_entries where organization_id = $1`, [org]))[0].s)
    expect(-(await sumLines(`account = 'organizer_payable' and organization_id = '${org}'`))).toBe(sub)
    expect(sub).toBe(14250 + 14550)
  })

  it('refunds return commission in proportion, reduce what can be withdrawn while open, and post a balanced reversal', async () => {
    const o = (await server(`select id from public.orders where event_id = $1 and buyer = $2 and status = 'paid' and total_cents > 0`, [ev, buyer]))[0]
    const r = (await as(buyer, `select public.request_refund($1, 'cannot make it') as r`, [o.id]))[0].r
    await expect(as(buyer, `select public.request_refund($1, 'again')`, [o.id])).rejects.toThrow(/in progress/)
    const bal = (await as(host, `select public.payout_balance($1) as b`, [org]))[0].b
    expect(bal.committed_refunds_cents).toBe(14250)                                                   // the organiser's share is held back
    await server(`select public.refund_claim($1)`, [r.id]); await server(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-27')`, [r.id])
    const lines = await server(`select account, amount_cents::int as a from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.refund_id = $1 order by l.id`, [r.id])
    expect(lines).toEqual([{ account: 'organizer_payable', a: 14250 }, { account: 'commission_revenue', a: 750 }, { account: 'platform_cash', a: -15000 }])
    expect(await sumLines()).toBe(0)
    expect((await as(host, `select public.payout_balance($1) as b`, [org]))[0].b.committed_refunds_cents).toBe(0)
  })

  it('a payment that lands after the hold lapsed on a sold-out type is never lost: refund owed, held, flagged', async () => {
    const owedBefore = -(await sumLines(`account = 'refunds_payable'`))
    const late = await order(stranger, [{ tt, qty: 1 }])
    await server(`update public.orders set expires_at = now() - interval '1 minute' where id = $1`, [late.id])
    const o3 = await order(buyer2, [{ tt, qty: 2 }]); await pay(o3)                                  // the stock goes to someone else
    await pay(late)                                                                                   // then the late money arrives
    const row = (await server(`select status from public.orders where id = $1`, [late.id]))[0]
    expect(row.status).toBe('failed')
    expect((await server(`select count(*)::int as n from public.tickets where order_id = $1`, [late.id]))[0].n).toBe(0)
    const rf = (await server(`select id, kind, status, ticket_amount_cents::int + fee_amount_cents::int as total from public.refunds where order_id = $1`, [late.id]))[0]
    expect(rf).toMatchObject({ kind: 'oversold', status: 'approved', total: late.total_cents })
    expect((await as(stranger, `select status from public.refunds where order_id = $1`, [late.id]))).toEqual([{ status: 'approved' }])   // the buyer can see it
    expect((await server(`select 1 from public.reconciliation_exceptions where kind = 'paid_after_expiry_soldout' and ref_key = $1 and status = 'open'`, [late.id]))).toHaveLength(1)
    expect(-(await sumLines(`account = 'refunds_payable'`))).toBe(owedBefore + late.total_cents)
    await pay(late)                                                                                   // repeated notification: nothing new
    expect((await server(`select count(*)::int as n from public.refunds where order_id = $1`, [late.id]))[0].n).toBe(1)
    await server(`select public.refund_claim($1)`, [rf.id]); await server(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-late')`, [rf.id])
    expect(-(await sumLines(`account = 'refunds_payable'`)) + 0).toBe(owedBefore)
    expect((await server(`select status from public.orders where id = $1`, [late.id]))[0].status).toBe('refunded')
  })

  it('a hold that lapsed but was not swept yet does not reserve stock (no oversell through a stale pending order)', async () => {
    const t2 = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'Last one', 10000, 1, 1) returning id`, [ev]))[0].id
    const a = await order(buyer, [{ tt: t2, qty: 1 }])
    await server(`update public.orders set expires_at = now() - interval '1 second' where id = $1`, [a.id])
    const b = await order(stranger, [{ tt: t2, qty: 1 }]); await pay(b)
    await pay(a)                                                                                      // still status pending, but lapsed
    expect((await server(`select count(*)::int as n from public.tickets where ticket_type_id = $1`, [t2]))[0].n).toBe(1)
    expect((await server(`select kind from public.refunds where order_id = $1`, [a.id]))[0].kind).toBe('oversold')
  })

  it('payment notifications are recorded once per transaction and status; mismatches open a critical case', async () => {
    const one = (await server(`select public.record_payment_notification('payfast', 'pf-777', 'COMPLETE', $1, 100, 'ZAR') as r`, [ev]))[0].r
    const two = (await server(`select public.record_payment_notification('payfast', 'pf-777', 'COMPLETE', $1, 100, 'ZAR') as r`, [ev]))[0].r
    expect(one.duplicate).toBe(false); expect(two.duplicate).toBe(true); expect(two.id).toBe(one.id)
    await server(`select public.finish_payment_notification($1, 'amount_mismatch')`, [one.id])
    expect((await server(`select severity from public.reconciliation_exceptions where kind = 'payment_amount_mismatch' and ref_key = 'payfast:pf-777'`))[0].severity).toBe('critical')
    await expect(as(buyer, `select public.record_payment_notification('payfast', 'x', 'COMPLETE', 'y', 1, 'ZAR')`)).rejects.toThrow()
    expect(await as(buyer, `select 1 from public.payment_notifications`)).toHaveLength(0)
  })

  it('admission: codes are private to the holder; scanners are assigned per event; redemption is single-use, event-bound and logged', async () => {
    const tk = (await as(buyer2, `select id, public.my_ticket_code(id) as code from public.tickets where owner = auth.uid() and event_id = $1 and status = 'valid' limit 1`, [ev]))[0]
    expect(tk.code).toMatch(/^[A-F0-9]{20}$/)
    await expect(as(host, `select code from public.tickets where event_id = $1`, [ev])).rejects.toThrow(/permission denied/)      // organisers never see codes
    expect((await as(host, `select public.my_ticket_code($1) as c`, [tk.id]))[0].c).toBeNull()
    expect((await as(scanner, `select public.admit_ticket($1, $2) as r`, [ev, tk.code]))[0].r.result).toBe('forbidden')
    await expect(as(scanner, `insert into public.event_staff (event_id, user_id, added_by) values ($1, auth.uid(), auth.uid())`, [ev])).rejects.toThrow()   // cannot add yourself
    await as(host, `insert into public.event_staff (event_id, user_id, added_by) values ($1, $2, auth.uid())`, [ev, scanner])
    const other = (await as(host, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Other night', now() + interval '2 days') returning id`))[0].id
    expect((await as(host, `select public.admit_ticket($1, $2) as r`, [other, tk.code]))[0].r.result).toBe('wrong_event')
    const first = (await as(scanner, `select public.admit_ticket($1, $2) as r`, [ev, `VYBE1:${tk.code.toLowerCase()}`]))[0].r
    expect(first).toMatchObject({ result: 'ok', ticket_type: 'GA' }); expect(first.holder).toBeTruthy()
    const again = (await as(scanner, `select public.admit_ticket($1, $2) as r`, [ev, tk.code]))[0].r
    expect(again.result).toBe('already_used'); expect(again.used_at).toBeTruthy()
    expect((await as(scanner, `select public.admit_ticket($1, 'NOTAREALCODE')as r`, [ev]))[0].r.result).toBe('invalid')
    const scans = await as(host, `select result from public.ticket_scans where event_id = $1 order by id`, [ev])
    expect(scans.map((s: any) => s.result)).toEqual(expect.arrayContaining(['ok', 'already_used', 'invalid']))
    expect(await as(scanner, `select 1 from public.ticket_scans`)).toHaveLength(0)                  // scanners do not browse the log
    expect(await as(stranger, `select 1 from public.ticket_scans`)).toHaveLength(0)
  })

  it('admission: refunded tickets and cancelled events are refused; bursts of bad codes are throttled', async () => {
    const refunded = (await server(`select code from public.tickets where status = 'refunded' and event_id = $1 limit 1`, [ev]))[0].code
    expect((await as(scanner, `select public.admit_ticket($1, $2) as r`, [ev, refunded]))[0].r.result).toBe('refunded')
    for (let i = 0; i < 40; i++) await as(scanner, `select public.admit_ticket($1, $2)`, [ev, `BAD${i}`])
    expect((await as(scanner, `select public.admit_ticket($1, 'ANYTHING') as r`, [ev]))[0].r.result).toBe('rate_limited')
  })

  it('lineup: verification status belongs to VYBE; editing a confirmed act marks it CHANGED; history is kept', async () => {
    const l = (await as(host, `insert into public.event_lineup (event_id, name, role) values ($1, 'DJ Fresh', 'Headliner') returning id, status`, [ev]))[0]
    expect(l.status).toBe('pending')
    await expect(as(host, `update public.event_lineup set status = 'confirmed' where id = $1`, [l.id])).rejects.toThrow()       // no column grant
    await expect(as(admin, `select public.admin_set_lineup_status($1, 'confirmed', '')`, [l.id])).rejects.toThrow(/how this was established/)
    await as(admin, `select public.admin_set_lineup_status($1, 'confirmed', 'Agent confirmed by email from the agency domain')`, [l.id])
    await as(host, `update public.event_lineup set name = 'DJ Fresh (b2b)' where id = $1`, [l.id])
    expect((await as(buyer, `select status from public.event_lineup where id = $1`, [l.id]))[0].status).toBe('changed')
    const h = await as(host, `select op from public.event_lineup_history where lineup_id = $1 order by id`, [l.id])
    expect(h.map((r: any) => r.op)).toEqual(['insert', 'status', 'update'])
  })

  it('payouts: cooling-off after bank changes, requester ≠ approver, dual control above the limit, re-check at confirmation', async () => {
    await server(`update public.events set starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' where id = $1`, [ev])
    const acct = (await server(`insert into public.payout_accounts (organization_id, holder, bank, account_last4, details_enc, status) values ($1, 'Night Co', 'FNB', '4321', 'c', 'verified') returning id`, [org]))[0].id
    await expect(as(host, `select public.request_payout($1)`, [org])).rejects.toThrow(/changed recently/)
    await server(`update public.payout_accounts set updated_at = now() - interval '4 days' where id = $1`, [acct])
    await server(`update public.platform_config set payout_min_cents = 100, payout_dual_control_cents = 1000`)
    await expect(as(editor, `select public.request_payout($1)`, [org])).rejects.toThrow(/forbidden/)       // editors cannot withdraw
    const p = (await as(host, `select public.request_payout($1) as p`, [org]))[0].p
    const amt = Number((await server(`select amount_cents from public.payouts where id = $1`, [p]))[0].amount_cents)
    expect(amt).toBeGreaterThan(1000)
    await as(admin, `select public.admin_decide_payout($1, true, 'checks out')`, [p])
    await expect(as(admin, `select public.admin_mark_payout_paid($1, 'EFT-27')`, [p])).rejects.toThrow(/second admin/)
    await expect(as(admin2, `select public.admin_mark_payout_paid($1, '')`, [p])).rejects.toThrow(/reference/)
    await as(admin2, `select public.admin_mark_payout_paid($1, 'EFT-27')`, [p])
    expect(-(await sumLines(`account = 'organizer_payable' and organization_id = '${org}'`)) + 0).toBe(Number((await as(host, `select public.payout_balance($1) as b`, [org]))[0].b.balance_cents))
    expect(await sumLines()).toBe(0)
    await as(admin, `select public.finance_reconcile()`)
    expect(await as(admin, `select kind from public.reconciliation_exceptions where status = 'open' and kind = 'payable_mismatch'`)).toEqual([])
  })

  it('finance overview comes from the journal and says what it is based on', async () => {
    await expect(as(host, `select public.admin_ticket_finance()`)).rejects.toThrow(/forbidden/)
    const f = (await as(admin, `select public.admin_ticket_finance(now() - interval '1 day', now() + interval '1 minute') as f`))[0].f
    expect(f.basis).toMatch(/provider-confirmed/)
    expect(f.commission_revenue_cents).toBe(750 + 450 + 900 + 300 - 750)        // 5 % sale, 3 % sale, 2-ticket 3 % sale, R100 at 3 %, minus the refunded 5 %
    expect(f.processing_costs).toMatch(/PayFast fees are recorded/)
  })

  it('trigger functions cannot be called over the API', async () => {
    const r = await server(`select count(*)::int as n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
                            and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`)
    expect(r[0].n).toBe(0)
  })
})

describe('migration 29: risk engine, material changes, reviews and complaints, promoter referrals, exports', () => {
  let host = '', buyer = '', fan = '', promoter = '', stranger = '', admin = '', admin2 = '', org = '', ev = '', tt = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const order = (uid: string, qty = 1, ref: string | null = null, event = ev, type = tt) =>
    as(uid, `select public.create_order($1, $2::jsonb, 'payfast', $3, $4) as o`, [event, JSON.stringify([{ ticket_type_id: type, qty }]), crypto.randomUUID(), ref]).then(r => r[0].o)
  const pay = (o: { id: string; total_cents: number }) => server(`select public.fulfill_order($1, 'payfast', $2, $3, 'cc')`, [o.id, 'pf-' + crypto.randomUUID(), o.total_cents])
  const cases = (rule: string) => server(`select subject_type, subject_id, action, status from public.risk_cases where rule_key = $1`, [rule])
  const sum = async (where: string) => Number((await server(`select coalesce(sum(amount_cents), 0) as s from public.journal_lines where ${where}`))[0].s)

  it('setup: an approved organisation event', async () => {
    await server(`update public.platform_config set require_sales_review = true, payout_account_cooloff_hours = 0, payout_min_cents = 100, payout_dual_control_cents = 100000000`)
    host = await mk('m28host'); buyer = await mk('m28buyer'); fan = await mk('m28fan'); promoter = await mk('m28promo'); stranger = await mk('m28stranger'); admin = await mk('m28admin'); admin2 = await mk('m28admin2')
    await server(`insert into public.staff (user_id, role) values ($1, 'admin'), ($2, 'admin')`, [admin, admin2])
    org = (await as(host, `insert into public.organizations (name, slug, kind, created_by) values ('Sunset Co', 'm28-sunset', 'organizer', auth.uid()) returning id`))[0].id
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility, organization_id, venue, city) values (auth.uid(), 'Sunset sessions', now() + interval '30 days', 'UTC', 'public', $1, 'The Pier', 'Durban') returning id`, [org]))[0].id
    tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'GA', 20000, 200, 4) returning id`, [ev]))[0].id
    await server(`update public.events set sales_review = 'approved' where id = $1`, [ev])
  })

  it('risk rules and cases are admin-only; an organiser buying their own tickets is flagged but not blocked', async () => {
    expect(await as(host, `select 1 from public.risk_rules`)).toHaveLength(0)
    const o = await order(host); await pay(o)
    expect((await server(`select status from public.orders where id = $1`, [o.id]))[0].status).toBe('paid')
    expect(await cases('organiser_self_purchase')).toEqual([{ subject_type: 'event', subject_id: ev, action: 'MONITOR', status: 'open' }])
    expect(await as(host, `select 1 from public.risk_cases`)).toHaveLength(0)
  })

  it('a burst of failed payments pauses purchases (reversibly); cancelling checkouts does not', async () => {
    for (let i = 0; i < 4; i++) { const o = await order(stranger); await as(stranger, `select public.cancel_my_order($1)`, [o.id]) }
    expect(await cases('buyer_failed_payments')).toHaveLength(0)
    await server(`update public.orders set created_at = now() - interval '11 minutes' where buyer = $1`, [stranger])   // past the per-buyer velocity limit
    for (let i = 0; i < 5; i++) { const o = await order(stranger); await server(`select public.close_order($1, 'failed')`, [o.id]); await server(`update public.orders set created_at = now() - interval '11 minutes' where id = $1`, [o.id]) }
    expect((await cases('buyer_failed_payments'))[0]).toMatchObject({ subject_type: 'user', subject_id: stranger, action: 'RESTRICT_ACCOUNT' })
    await expect(order(stranger)).rejects.toThrow(/paused on this account/)
    const id = (await server(`select id from public.risk_cases where rule_key = 'buyer_failed_payments'`))[0].id
    await expect(as(host, `select public.admin_decide_risk_case($1, 'dismissed', 'looks fine')`, [id])).rejects.toThrow(/forbidden/)
    await expect(as(admin, `select public.admin_decide_risk_case($1, 'dismissed', '')`, [id])).rejects.toThrow(/reason/)
    await as(admin, `select public.admin_decide_risk_case($1, 'dismissed', 'Bank outage that evening; buyer confirmed by phone')`, [id])
    expect((await order(stranger)).status).toBe('pending')                                        // false positive cleared
  })

  it('promoter links: outside the team only; attribution only on payment; never to the buyer themselves', async () => {
    await expect(as(stranger, `select public.create_promoter_link($1, 'm28promo', 1000)`, [ev])).rejects.toThrow(/forbidden/)
    await expect(as(host, `select public.create_promoter_link($1, 'm28host', 1000)`, [ev])).rejects.toThrow(/outside the organising team/)
    const link = (await as(host, `select public.create_promoter_link($1, 'm28promo', 1000) as l`, [ev]))[0].l
    expect(link.code).toMatch(/^[A-Z0-9]{8}$/)
    const self = await order(promoter, 1, link.code); await pay(self)
    expect((await server(`select referral_link_id from public.orders where id = $1`, [self.id]))[0].referral_link_id).toBeNull()
    expect(await cases('self_referral')).toHaveLength(1)
    const o = await order(buyer, 2, link.code.toLowerCase())
    expect(await server(`select 1 from public.referral_attributions where order_id = $1`, [o.id])).toHaveLength(0)  // not paid yet
    await pay(o)
    const a = (await server(`select commission_cents::int as c, status from public.referral_attributions where order_id = $1`, [o.id]))[0]
    expect(a).toEqual({ c: 4000, status: 'earned' })                                                  // 10 % of R400 net (platform v1: no commission)
    expect(-(await sum(`account = 'promoter_payable' and payee_user = '${promoter}'`))).toBe(4000)
    expect((await as(promoter, `select public.my_promoter_earnings() as e`))[0].e[0]).toMatchObject({ code: link.code, orders: 1, earned_cents: 4000 })
    expect(await as(stranger, `select 1 from public.referral_attributions`)).toHaveLength(0)
    await as(admin, `select public.finance_reconcile()`)
    expect(await server(`select 1 from public.reconciliation_exceptions where status = 'open' and kind in ('payable_mismatch', 'journal_unbalanced')`)).toEqual([])
  })

  it('a material change (event moved) tells holders and makes earlier purchases refundable at once, fee included', async () => {
    const before = await server(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'event_update'`, [buyer])
    await as(host, `update public.events set starts_at = starts_at + interval '1 day', venue = 'The Harbour' where id = $1`, [ev])
    const e = (await server(`select material_change_at, material_change_note from public.events where id = $1`, [ev]))[0]
    expect(e.material_change_at).not.toBeNull(); expect(e.material_change_note).toMatch(/Date or time changed\. Venue changed\./)
    expect((await server(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'event_update'`, [buyer]))[0].n).toBe(before[0].n + 1)
    await server(`update public.platform_config set buyer_refund_hours = 720`)                        // normally this would wait for the organiser
    const o = (await server(`select id, total_cents::int as t, fee_cents::int as f from public.orders where buyer = $1 and event_id = $2 and status = 'paid'`, [buyer, ev]))[0]
    const r = (await as(buyer, `select public.request_refund($1, 'new date does not work') as r`, [o.id]))[0].r
    expect(r.status).toBe('approved')
    expect(Number((await server(`select ticket_amount_cents + fee_amount_cents as t from public.refunds where id = $1`, [r.id]))[0].t)).toBe(o.t)
    await server(`update public.platform_config set buyer_refund_hours = 48`)
    await server(`select public.refund_claim($1)`, [r.id]); await server(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-mc')`, [r.id])
    // The promoter's share of the refunded order goes back to the organiser.
    expect((await server(`select status, reversed_cents::int as r from public.referral_attributions where order_id = $1`, [o.id]))[0]).toEqual({ status: 'reversed', r: 4000 })
    expect(await sum(`account = 'promoter_payable' and payee_user = '${promoter}'`)).toBe(0)
    expect(await sum('true')).toBe(0)
  })

  it('a high refund rate puts the payee\'s payouts on hold; the organiser sees the hold (not the rule) and can appeal', async () => {
    await server(`update public.risk_rules set threshold = 5 where key = 'refund_rate_high'`)
    for (let i = 0; i < 9; i++) { const u = await mk(`m28f${i}`); const o = await order(u); await pay(o) }
    const u = await mk('m28last'); const o = await order(u); await pay(o)
    const r = (await as(u, `select public.request_refund($1, 'x') as r`, [o.id]))[0].r
    await server(`select public.refund_claim($1)`, [r.id]); await server(`select public.refund_finish($1, 'succeeded', 'payfast', 'rf-rate')`, [r.id])
    expect((await cases('refund_rate_high'))[0]).toMatchObject({ subject_type: 'organization', subject_id: org, action: 'PAUSE_PAYOUT' })
    const holds = (await as(host, `select public.my_payout_holds($1) as h`, [org]))[0].h
    expect(holds).toHaveLength(1); expect(Object.keys(holds[0]).sort()).toEqual(['appealed', 'id', 'since', 'status'])   // no rule, no thresholds
    await server(`update public.events set starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' where id = $1`, [ev])
    await server(`insert into public.payout_accounts (organization_id, holder, bank, account_last4, details_enc, status, updated_at) values ($1, 'Sunset', 'FNB', '9876', 'c', 'verified', now() - interval '10 days')`, [org])
    await expect(as(host, `select public.request_payout($1)`, [org])).rejects.toThrow(/on hold/)
    await expect(as(stranger, `select public.appeal_payout_hold($1, 'please release my money now')`, [holds[0].id])).rejects.toThrow(/forbidden/)
    await as(host, `select public.appeal_payout_hold($1, 'Refunds were because the venue moved; see the event history.')`, [holds[0].id])
    await expect(as(host, `select public.request_payout($1)`, [org])).rejects.toThrow(/on hold/)        // an appeal does not lift the hold by itself
    await as(admin, `select public.admin_decide_risk_case($1, 'dismissed', 'Refunds follow the declared venue change')`, [holds[0].id])
    const p = (await as(host, `select public.request_payout($1) as p`, [org]))[0].p
    expect(p).toBeTruthy()
  })

  it('other signals: duplicate events, counterfeit-code bursts, a confirmed act changed after approval; rules are tunable', async () => {
    await as(stranger, `insert into public.events (host, title, starts_at, timezone) values (auth.uid(), 'Sunset sessions', (select starts_at from public.events where id = $1), 'UTC')`, [ev])
    expect((await cases('duplicate_event')).length).toBeGreaterThanOrEqual(1)
    await expect(as(host, `select public.admin_set_risk_rule('invalid_scans', true, 3, 60, 'ESCALATE_TO_TRUST_TEAM')`)).rejects.toThrow(/forbidden/)
    await as(admin, `select public.admin_set_risk_rule('invalid_scans', true, 3, 60, 'ESCALATE_TO_TRUST_TEAM')`)
    for (let i = 0; i < 3; i++) await as(host, `select public.admit_ticket($1, $2)`, [ev, `FAKE${i}`])
    expect((await cases('invalid_scans'))[0]).toMatchObject({ action: 'ESCALATE_TO_TRUST_TEAM' })
    const l = (await as(host, `insert into public.event_lineup (event_id, name, role) values ($1, 'Black Coffee', 'Headliner') returning id`, [ev]))[0].id
    await as(admin, `select public.admin_set_lineup_status($1, 'confirmed', 'Confirmed with management by email')`, [l])
    await as(host, `update public.event_lineup set name = 'Black Coffee (DJ set)' where id = $1`, [l])
    expect((await cases('lineup_changed_after_approval')).filter((c: any) => c.subject_id === ev)).toHaveLength(1)
  })

  it('reviews: ticket holders only, after the event; verified only when scanned; organisers cannot review themselves', async () => {
    const e2 = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Picnic', now() + interval '1 day', 'UTC', 'public') returning id`))[0].id
    const free = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'Free', 0, 50, 2) returning id`, [e2]))[0].id
    for (const u of [buyer, fan]) await order(u, 1, null, e2, free)
    await expect(as(buyer, `select public.submit_event_review($1, 5, 'great')`, [e2])).rejects.toThrow(/once the event is over/)
    const code = (await as(fan, `select public.my_ticket_code(id) as c from public.tickets where owner = auth.uid() and event_id = $1`, [e2]))[0].c
    await as(host, `select public.admit_ticket($1, $2)`, [e2, code])
    await server(`update public.events set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = $1`, [e2])
    await expect(as(host, `select public.submit_event_review($1, 5, 'we were amazing')`, [e2])).rejects.toThrow(/Organisers cannot review/)
    await expect(as(stranger, `select public.submit_event_review($1, 1, 'terrible')`, [e2])).rejects.toThrow(/Only ticket holders/)
    await as(buyer, `select public.submit_event_review($1, 4, 'Lovely afternoon')`, [e2])
    await as(fan, `select public.submit_event_review($1, 5, 'Best picnic')`, [e2])
    const rows = await as(stranger, `select author, verified_attendee from public.event_reviews where event_id = $1 order by created_at`, [e2])
    expect(rows.map((r: any) => r.verified_attendee)).toEqual([false, true])                          // only the scanned ticket counts as attendance
    expect((await as(stranger, `select public.event_review_summary($1) as s`, [e2]))[0].s).toMatchObject({ count: 2, verified: 1, average: null })   // too few for a score
    await as(buyer, `select public.submit_event_review($1, 3, 'On reflection, ok')`, [e2])              // editing, not a second review
    expect((await server(`select count(*)::int as n from public.event_reviews where event_id = $1`, [e2]))[0].n).toBe(2)
    const rid = (await server(`select id from public.event_reviews where author = $1 and event_id = $2`, [buyer, e2]))[0].id
    await expect(as(stranger, `select public.respond_to_review($1, 'thanks')`, [rid])).rejects.toThrow(/forbidden/)
    await as(host, `select public.respond_to_review($1, 'Thanks for coming!')`, [rid])
    await expect(as(admin, `select public.admin_moderate_review($1, 'hidden', '')`, [rid])).rejects.toThrow(/reason/)
    await as(admin, `select public.admin_moderate_review($1, 'hidden', 'Contains a phone number')`, [rid])
    expect(await as(stranger, `select 1 from public.event_reviews where id = $1`, [rid])).toHaveLength(0)
    expect((await as(buyer, `select status, moderation_note from public.event_reviews where id = $1`, [rid]))[0]).toEqual({ status: 'hidden', moderation_note: 'Contains a phone number' })
    await as(stranger, `insert into public.reports (reporter, entity_type, entity_id, reason) values (auth.uid(), 'event_review', (select id from public.event_reviews where author = $1), 'fake review')`, [fan])
  })

  it('complaints are private between the buyer, the organiser and VYBE, and can be escalated', async () => {
    const nobody = await mk('m28nobody')
    await expect(as(nobody, `select public.submit_complaint($1, 'Hello', 'I was never there but anyway')`, [ev])).rejects.toThrow(/bought or hold tickets/)
    const c = (await as(buyer, `select public.submit_complaint($1, 'Sound was off', 'The sound cut out for an hour during the main set.') as c`, [ev]))[0].c
    expect(await as(stranger, `select 1 from public.event_complaints`)).toHaveLength(0)
    expect(await as(host, `select 1 from public.event_complaints where id = $1`, [c])).toHaveLength(1)
    await expect(as(stranger, `select public.reply_complaint($1, 'go away')`, [c])).rejects.toThrow(/forbidden/)
    await as(host, `select public.reply_complaint($1, 'Sorry — a generator failed. We are offering partial refunds.')`, [c])
    await as(buyer, `select public.escalate_complaint($1)`, [c])
    await expect(as(host, `select public.admin_close_complaint($1, 'done')`, [c])).rejects.toThrow(/forbidden/)
    await as(admin, `select public.admin_close_complaint($1, 'Partial refund agreed with the organiser')`, [c])
    expect((await as(buyer, `select status from public.event_complaints where id = $1`, [c]))[0].status).toBe('closed')
  })

  it('exports: sales (no contact details) and the door list, for the event\'s managers only; each export is audited', async () => {
    await expect(as(stranger, `select public.event_sales_export($1)`, [ev])).rejects.toThrow(/forbidden/)
    const s = (await as(host, `select public.event_sales_export($1) as s`, [ev]))[0].s
    expect(s.length).toBeGreaterThan(5)
    expect(JSON.stringify(s)).not.toMatch(/@example\.com/); expect(Object.keys(s[0])).not.toContain('buyer')
    expect(Object.keys(s[0])).toEqual(expect.arrayContaining(['order', 'status', 'tickets', 'ticket_subtotal_cents', 'commission_cents', 'organizer_net_cents', 'promoter_code']))
    const d = (await as(host, `select public.event_door_list($1) as d`, [ev]))[0].d
    expect(Object.keys(d[0]).sort()).toEqual(['checked_in_at', 'holder', 'status', 'ticket_type'])
    expect((await server(`select count(*)::int as n from public.audit_log where action like 'export.%' and entity_id = $1`, [ev]))[0].n).toBe(2)
  })

  it('security fix: outsiders can no longer read another organisation\'s payout balance or request its payout', async () => {
    await expect(as(stranger, `select public.payout_balance($1)`, [org])).rejects.toThrow(/forbidden/)
    await expect(as(stranger, `select public.request_payout($1)`, [org])).rejects.toThrow(/forbidden/)
    await expect(as(stranger, `select public.my_payout_holds($1)`, [org])).rejects.toThrow(/forbidden/)
    expect((await as(stranger, `select public.can_view_finance($1, null) as v`, [org]))[0].v).toBe(false)
  })
  it('the books still balance and reconcile after all of it', async () => {
    expect(await sum('true')).toBe(0)
    await as(admin, `select public.finance_reconcile()`)
    expect(await server(`select kind from public.reconciliation_exceptions where status = 'open' and kind in ('payable_mismatch', 'journal_unbalanced', 'ticket_count_mismatch', 'missing_sale_journal')`)).toEqual([])
  })
})

describe('migration 30: organiser commission terms, processing fees, payout failure, email outbox', () => {
  let host = '', buyer = '', bystander = '', admin = '', admin2 = '', ev = '', tt = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const order = (uid: string, qty = 1) => as(uid, `select public.create_order($1, $2::jsonb, 'payfast', $3) as o`, [ev, JSON.stringify([{ ticket_type_id: tt, qty }]), crypto.randomUUID()]).then(r => r[0].o)
  const pay = (o: { id: string; total_cents: number }, ref: string) => server(`select public.fulfill_order($1, 'payfast', $2, $3, 'cc')`, [o.id, ref, o.total_cents])
  const key = async () => (await server(`select key from vybe_private.workers where name = 'email'`))[0].key as string

  it('setup', async () => {
    await server(`update public.platform_config set require_sales_review = true, payout_account_cooloff_hours = 0, payout_min_cents = 100, payout_dual_control_cents = 100000000`)
    await db.exec(`reset role; alter table public.fee_policies disable trigger fee_policy_immutable;
      update public.fee_policies set retired_at = null where name = 'Platform v2 (organiser commission)';
      update public.fee_policies set retired_at = (select effective_from from public.fee_policies where name = 'Platform v2 (organiser commission)') where name = 'Platform v1 (launch terms)';
      alter table public.fee_policies enable trigger fee_policy_immutable;`)
    host = await mk('m29host'); buyer = await mk('m29buyer'); bystander = await mk('m29by'); admin = await mk('m29admin'); admin2 = await mk('m29admin2')
    await server(`insert into public.staff (user_id, role) values ($1, 'admin'), ($2, 'admin')`, [admin, admin2])
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Commission night', now() + interval '20 days', 'UTC', 'public') returning id`))[0].id
    tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'GA', 15000, 100, 4) returning id`, [ev]))[0].id
    await server(`update public.events set sales_review = 'approved' where id = $1`, [ev])
  })

  it('new orders use the v2 terms: buyers pay face value, organisers pay 5 % commission; v1 is retired, not deleted', async () => {
    const live = await server(`select name, commission_bps, buyer_fee_enabled from public.fee_policies where scope = 'platform' and retired_at is null`)
    expect(live).toEqual([{ name: 'Platform v2 (organiser commission)', commission_bps: 500, buyer_fee_enabled: false }])
    expect((await server(`select count(*)::int n from public.fee_policies where scope = 'platform' and retired_at is not null`))[0].n).toBeGreaterThanOrEqual(1)
    const o = await order(buyer, 2)
    expect(o.total_cents).toBe(30000)
    const row = (await server(`select fee_cents, commission_cents, organizer_net_cents, pricing->>'policy_name' as p from public.orders where id = $1`, [o.id]))[0]
    expect(row).toEqual({ fee_cents: 0, commission_cents: 1500, organizer_net_cents: 28500, p: 'Platform v2 (organiser commission)' })
    await pay(o, 'pf-m29-1')
    const sale = await server(`select l.account, l.amount_cents::int a from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.idempotency_key = $1 order by 1`, ['sale:' + o.id])
    expect(sale).toEqual([{ account: 'commission_revenue', a: -1500 }, { account: 'organizer_payable', a: -28500 }, { account: 'platform_cash', a: 30000 }])
    expect(Number((await server(`select coalesce(sum(amount_cents),0) s from public.ledger_entries where order_id = $1`, [o.id]))[0].s)).toBe(28500)
  })

  it('the provider fee is a VYBE cost: booked once, never from the organiser, refused when implausible, only for money received', async () => {
    const o = (await server(`select id, total_cents from public.orders where buyer = $1 and status = 'paid'`, [buyer]))[0]
    await expect(as(buyer, `select public.record_processing_fee($1, 'payfast', 'pf-m29-1', 790)`, [o.id])).rejects.toThrow(/permission denied/)
    expect((await server(`select public.record_processing_fee($1, 'payfast', 'pf-m29-1', 790) as r`, [o.id]))[0].r).toBe(true)
    expect((await server(`select public.record_processing_fee($1, 'payfast', 'pf-m29-1', 790) as r`, [o.id]))[0].r).toBe(false)     // same notification again
    const lines = await server(`select l.account, l.amount_cents::int a from public.journal_lines l join public.journal_entries e on e.id = l.entry_id where e.kind = 'processing_fee' and e.order_id = $1 order by 1`, [o.id])
    expect(lines).toEqual([{ account: 'platform_cash', a: -790 }, { account: 'processing_expense', a: 790 }])
    expect((await server(`select processing_fee_cents::int f from public.orders where id = $1`, [o.id]))[0].f).toBe(790)
    expect(Number((await server(`select coalesce(sum(amount_cents),0) s from public.ledger_entries where order_id = $1`, [o.id]))[0].s)).toBe(28500)   // organiser unaffected
    const pending = await order(buyer, 1)
    expect((await server(`select public.record_processing_fee($1, 'payfast', 'pf-x', 100) as r`, [pending.id]))[0].r).toBe(false)
    const o2 = await order(buyer, 1); await pay(o2, 'pf-m29-2')
    expect((await server(`select public.record_processing_fee($1, 'payfast', 'pf-m29-2', 999999) as r`, [o2.id]))[0].r).toBe(false)
    expect((await server(`select count(*)::int n from public.reconciliation_exceptions where kind = 'processing_fee_implausible' and ref_key = $1`, [o2.id]))[0].n).toBe(1)
    const fin = (await as(admin, `select public.admin_ticket_finance() as f`))[0].f
    expect(fin.processing_costs_cents).toBeGreaterThanOrEqual(790)
  })

  it('an approved payout that could not be paid is marked failed with a reason, and the money is available again', async () => {
    await server(`update public.orders set paid_at = now() - interval '40 days' where event_id = $1`, [ev])
    await server(`update public.events set starts_at = now() - interval '30 days' where id = $1`, [ev])
    await server(`insert into public.payout_accounts (user_id, holder, bank, account_last4, details_enc, status) values ($1, 'M29 Host', 'FNB', '1234', 'c', 'verified')`, [host])
    const before = (await as(host, `select public.payout_balance(null) as b`))[0].b.available_cents
    expect(before).toBeGreaterThan(0)
    const pid = (await as(host, `select public.request_payout(null) as p`))[0].p
    await as(admin, `select public.admin_decide_payout($1, true, '')`, [pid])
    await expect(as(host, `select public.admin_mark_payout_failed($1, 'bounced')`, [pid])).rejects.toThrow(/forbidden/)
    await expect(as(admin2, `select public.admin_mark_payout_failed($1, '')`, [pid])).rejects.toThrow(/went wrong/)
    await as(admin2, `select public.admin_mark_payout_failed($1, 'Bank rejected: account closed')`, [pid])
    expect((await server(`select status, note from public.payouts where id = $1`, [pid]))[0]).toEqual({ status: 'failed', note: 'Bank rejected: account closed' })
    expect((await as(host, `select public.payout_balance(null) as b`))[0].b.available_cents).toBe(before)
    await expect(as(admin2, `select public.admin_mark_payout_failed($1, 'again please')`, [pid])).rejects.toThrow(/Only an approved payout/)
  })

  it('ticket and money notifications are queued for email; event changes only for ticket holders; the queue is closed to the API', async () => {
    const queued = await server(`select type, entity_type from public.email_outbox where user_id = $1 order by id`, [buyer])
    expect(queued.map((q: any) => q.type)).toContain('ticket_order')
    await as(bystander, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [ev]).catch(() => null)
    await server(`select public.notify($1, 'event_update', null, 'event', $2, 'm29-change-a')`, [bystander, ev])
    await server(`select public.notify($1, 'event_update', null, 'event', $2, 'm29-change-b')`, [buyer, ev])
    expect(await server(`select 1 from public.email_outbox where user_id = $1`, [bystander])).toHaveLength(0)
    expect(await server(`select 1 from public.email_outbox x join public.notifications n on n.id = x.notification_id where n.dedupe_key = 'm29-change-b'`)).toHaveLength(1)
    expect(await as(buyer, `select 1 from public.email_outbox`)).toHaveLength(0)
    expect((await as(admin, `select count(*)::int n from public.email_outbox`))[0].n).toBeGreaterThan(0)
    await expect(as(admin, `select key from vybe_private.workers`)).rejects.toThrow(/permission denied/)
    await expect(as(admin, `select public.email_worker_claim('x', 5)`)).rejects.toThrow(/permission denied/)
  })

  it('the email worker needs its key, claims each email once, and records the outcome', async () => {
    await expect(server(`select public.email_worker_claim($1, 5)`, ['0'.repeat(64)])).rejects.toThrow(/forbidden/)
    const k = await key()
    await server(`update public.email_outbox set status = 'skipped' where user_id <> $1`, [buyer])                     // other suites' mail
    const batch = (await server(`select public.email_worker_claim($1, 50) as b`, [k]))[0].b
    const mine = batch.find((b: any) => b.type === 'ticket_order' && b.order_status === 'paid')
    expect(mine).toMatchObject({ email: 'm29buyer@example.com', event_title: 'Commission night', order_total_cents: 30000 })
    expect((await server(`select public.email_worker_claim($1, 50) as b`, [k]))[0].b).toEqual([])                   // nothing claimed twice
    await server(`select public.email_worker_done($1, $2, 'sent')`, [k, mine.id])
    await server(`select public.email_worker_done($1, $2, 'pending', 'SMTP timeout')`, [k, batch[1].id])
    expect((await server(`select status, sent_at is not null s from public.email_outbox where id = $1`, [mine.id]))[0]).toEqual({ status: 'sent', s: true })
    expect((await server(`select status, attempts, last_error from public.email_outbox where id = $1`, [batch[1].id]))[0]).toEqual({ status: 'pending', attempts: 1, last_error: 'SMTP timeout' })
    await server(`update public.email_outbox set attempts = 5 where id = $1`, [batch[1].id])
    await server(`select public.email_worker_claim($1, 50)`, [k])
    expect((await server(`select status from public.email_outbox where id = $1`, [batch[1].id]))[0].status).toBe('failed')
  })

  it('buyers can see what they pay on top (nothing under v2), never the organiser commission', async () => {
    const t = (await as(bystander, `select public.buyer_fee_terms($1) as t`, [ev]))[0].t
    expect(t).toEqual({ buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 })
    expect(JSON.stringify(t)).not.toMatch(/commission/)
  })

  it('the books still balance and reconcile', async () => {
    expect(await server(`select entry_id from public.journal_lines group by entry_id having sum(amount_cents) <> 0`)).toEqual([])
    await server(`select public.finance_reconcile()`)
    expect(await server(`select kind, ref_key from public.reconciliation_exceptions where status = 'open' and kind in ('journal_unbalanced', 'payable_mismatch', 'missing_sale_journal', 'ticket_count_mismatch')`)).toEqual([])
  })
})

describe('migration 32: post song start, likes on comments', () => {
  let a = '', b = '', stranger = '', pub = '', priv = '', cPub = '', cPriv = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n, display_name: n })])).rows[0].id

  it('setup', async () => {
    a = await mk('m32a'); b = await mk('m32b'); stranger = await mk('m32stranger')
    const f = (await as(a, `insert into public.friendships (requester, addressee) values (auth.uid(), $1) returning id`, [b]))[0].id
    await as(b, `update public.friendships set status = 'accepted' where id = $1`, [f])
    pub = (await as(a, `insert into public.posts (author, body, music_title, music_start_ms) values (auth.uid(), 'song post', 'Zange', 51000) returning id`))[0].id
    priv = (await as(a, `insert into public.posts (author, body, visibility) values (auth.uid(), 'friends only', 'friends') returning id`))[0].id
    cPub = (await as(b, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), 'nice') returning id`, [pub]))[0].id
    cPriv = (await as(b, `insert into public.comments (post_id, author, body) values ($1, auth.uid(), 'hidden') returning id`, [priv]))[0].id
  })

  it('a post keeps the moment its song starts at; nonsense is refused', async () => {
    expect((await as(b, `select music_start_ms from public.posts where id = $1`, [pub]))[0].music_start_ms).toBe(51000)
    await fails(a, `insert into public.posts (author, body, music_start_ms) values (auth.uid(), 'bad', -5)`)
  })

  it('anyone who can see a comment can like it once, and unlike it', async () => {
    await as(stranger, `insert into public.comment_reactions (comment_id, user_id) values ($1, auth.uid())`, [cPub])
    await fails(stranger, `insert into public.comment_reactions (comment_id, user_id) values ($1, auth.uid())`, [cPub])
    expect(await as(a, `select * from public.comment_reactions where comment_id = $1`, [cPub])).toHaveLength(1)
    await as(stranger, `delete from public.comment_reactions where comment_id = $1`, [cPub])
    expect(await as(a, `select * from public.comment_reactions where comment_id = $1`, [cPub])).toHaveLength(0)
  })

  it('no liking for someone else, no liking what you cannot see, not readable signed out', async () => {
    await fails(stranger, `insert into public.comment_reactions (comment_id, user_id) values ($1, $2)`, [cPub, b])
    await fails(stranger, `insert into public.comment_reactions (comment_id, user_id) values ($1, auth.uid())`, [cPriv])
    await as(a, `insert into public.comment_reactions (comment_id, user_id) values ($1, auth.uid())`, [cPriv])
    expect(await as(stranger, `select * from public.comment_reactions where comment_id = $1`, [cPriv])).toHaveLength(0)
    expect(await as(b, `select * from public.comment_reactions where comment_id = $1`, [cPriv])).toHaveLength(1)
    await fails(null, `select * from public.comment_reactions`)
  })
})

describe('migration 33: branded ticket tiers, host trust card, email retries end', () => {
  let host = '', fan = '', stranger = '', ev = '', past = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }

  it('organisers brand their ticket tiers; values are checked; strangers cannot', async () => {
    host = await mk('m32host'); fan = await mk('m32fan'); stranger = await mk('m32stranger')
    ev = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Gold night', now() + interval '9 days', 'UTC', 'public') returning id`))[0].id
    const vip = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, tier, accent, design, perks) values ($1, 'VIP', 50000, 50, 'vip', '#c9a227', 'foil', '{"Fast lane","Free drink"}') returning id, tier, perks`, [ev]))[0]
    expect(vip).toMatchObject({ tier: 'vip', perks: ['Fast lane', 'Free drink'] })
    const ga = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total) values ($1, 'General', 15000, 100) returning tier, design, accent`, [ev]))[0]
    expect(ga).toEqual({ tier: 'general', design: 'aurora', accent: null })
    await expect(as(host, `update public.ticket_types set tier = 'platinum' where id = $1`, [vip.id])).rejects.toThrow()
    await expect(as(host, `update public.ticket_types set accent = 'red' where id = $1`, [vip.id])).rejects.toThrow()
    await expect(as(host, `update public.ticket_types set perks = $2 where id = $1`, [vip.id, ['a', 'b', 'c', 'd', 'e', 'f', 'g']])).rejects.toThrow()
    await expect(as(host, `update public.ticket_types set perks = $2 where id = $1`, [vip.id, ['x'.repeat(41)]])).rejects.toThrow()
    await as(host, `update public.ticket_types set tier = 'vvip', accent = '#111111', design = 'mesh' where id = $1`, [vip.id])
    expect(await as(stranger, `update public.ticket_types set tier = 'general' where id = $1 returning id`, [vip.id])).toHaveLength(0)
    expect((await as(fan, `select tier, accent, design from public.ticket_types where id = $1`, [vip.id]))[0]).toEqual({ tier: 'vvip', accent: '#111111', design: 'mesh' })
  })

  it('the host card counts only what the viewer may see, hides followers by the host\'s choice, and averages only from 3 reviews', async () => {
    past = (await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Last month', now() - interval '20 days', 'UTC', 'public') returning id`))[0].id
    await as(host, `insert into public.events (host, title, starts_at, timezone, visibility) values (auth.uid(), 'Secret', now() + interval '3 days', 'UTC', 'invite') returning id`)
    await as(fan, `insert into public.event_rsvps (event_id, user_id, status) values ($1, auth.uid(), 'going')`, [past])
    await as(fan, `insert into public.follows (follower, target_type, target_id) values (auth.uid(), 'profile', $1)`, [host])
    const r = (await as(stranger, `select public.host_reputation($1) as r`, [host]))[0].r
    expect(r).toMatchObject({ plans: 2, past_plans: 1, cancelled: 0, people_went: 1, reviews: 0, rating: null, approved_for_sales: false, verified: false })
    expect((await as(host, `select public.host_reputation($1) as r`, [host]))[0].r.plans).toBe(3)       // the host sees their invite-only plan too
    await server(`update public.profiles set show_followers = 'me' where id = $1`, [host])
    expect((await as(stranger, `select public.host_reputation($1) as r`, [host]))[0].r.followers).toBeNull()
    await server(`update public.profiles set show_followers = 'public' where id = $1`, [host])
    expect((await as(stranger, `select public.host_reputation($1) as r`, [host]))[0].r.followers).toBe(1)
    await expect(db.query(`reset role; select public.host_reputation($1)`, [host])).rejects.toThrow()
  })

  it('an email that used its 5 attempts is closed as failed', async () => {
    const k = (await server(`select key from vybe_private.workers where name = 'email'`))[0].key
    await server(`select public.notify($1, 'ticket_order', null, 'event', $2, 'm32-mail')`, [fan, ev])
    const id = (await server(`select x.id from public.email_outbox x join public.notifications n on n.id = x.notification_id where n.dedupe_key = 'm32-mail'`))[0].id
    await server(`update public.email_outbox set status = 'sending', attempts = 5 where id = $1`, [id])
    await server(`select public.email_worker_done($1, $2, 'pending', '525 unauthorized')`, [k, id])
    expect((await server(`select status from public.email_outbox where id = $1`, [id]))[0].status).toBe('failed')
  })
})

describe('migration 34: publishing rules (no music-only posts, real uploads only, one post per draft)', () => {
  let a = '', b = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const upload = (path: string) => server(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [path])

  it('setup: the real upload rule (no simulated uploads from here on)', async () => {
    await db.exec(`reset role; drop trigger if exists aa_test_simulate_upload on public.posts; drop trigger if exists aa_test_simulate_upload on public.post_media;`)
    a = await mk('m34a'); b = await mk('m34b')
  })

  it('meaningful text: words in any script count; spaces, invisible characters, punctuation and emoji alone do not', async () => {
    const t = async (x: string) => (await server(`select public.meaningful_text($1) as ok`, [x]))[0].ok
    for (const ok of ['Hi', 'ok', '42', 'Sawubona', 'Привет', 'こんにちは', 'مرحبا', 'Hi 🔥', '¿Qué?']) expect(await t(ok)).toBe(true)
    for (const no of ['', '   ', '\n\t', '\u200b\u200b', '…!!', '🔥🔥🔥', '❤️', '🇿🇦', '\u00a0', '- - -', '\u3000']) expect(await t(no)).toBe(false)
  })

  it('a text post needs meaningful text; a music-only post is refused even with a whitespace caption', async () => {
    await fails(a, `insert into public.posts (author, body) values (auth.uid(), '   ')`)
    await fails(a, `insert into public.posts (author, body) values (auth.uid(), '🔥🔥')`)
    await fails(a, `insert into public.posts (author, body, music_path, music_title) values (auth.uid(), '', $1, 'Song')`, [`${a}/song.mp3`])
    await fails(a, `insert into public.posts (author, body, music_path, music_title) values (auth.uid(), '  ', $1, 'Song')`, [`${a}/song.mp3`])
    expect(await as(a, `insert into public.posts (author, body) values (auth.uid(), 'Hi') returning id`)).toHaveLength(1)
  })

  it('a photo or video without a caption is fine once uploaded; with a song too', async () => {
    await upload(`${a}/p.jpg`); await upload(`${a}/v.mp4`)
    expect(await as(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'image') returning id`, [`${a}/p.jpg`])).toHaveLength(1)
    expect(await as(a, `insert into public.posts (author, body, media_path, media_type, music_path, music_title) values (auth.uid(), '', $1, 'video', $2, 'Song') returning id`, [`${a}/v.mp4`, `${a}/song.mp3`])).toHaveLength(1)
  })

  it('an upload that never finished, or someone else\'s file, cannot publish a post', async () => {
    await fails(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'video')`, [`${a}/never-uploaded.mp4`])
    await upload(`${b}/theirs.jpg`)
    await fails(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'image')`, [`${b}/theirs.jpg`])
    await fails(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), 'caption', $1, 'image')`, [`${b}/theirs.jpg`])
    const pid = (await as(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'image') returning id`, [`${a}/p.jpg`]))[0].id
    await fails(a, `insert into public.post_media (post_id, path, type, sort) values ($1, $2, 'image', 1)`, [pid, `${a}/missing.jpg`])
    expect(await as(a, `insert into public.post_media (post_id, path, type, sort) values ($1, $2, 'image', 0) returning post_id`, [pid, `${a}/p.jpg`])).toHaveLength(1)
  })

  it('the same draft published twice is one post', async () => {
    const key = crypto.randomUUID()
    await as(a, `insert into public.posts (author, body, client_key) values (auth.uid(), 'once', $1)`, [key])
    await expect(as(a, `insert into public.posts (author, body, client_key) values (auth.uid(), 'once', $1)`, [key])).rejects.toThrow(/duplicate|unique/)
    expect((await server(`select count(*)::int n from public.posts where client_key = $1`, [key]))[0].n).toBe(1)
    await as(b, `insert into public.posts (author, body, client_key) values (auth.uid(), 'another author, same key is fine', $1)`, [key])
  })
})

describe('migration 35: a smaller playback copy of a video (post_media.display_path)', () => {
  let a = '', b = '', pid = '', pidB = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const upload = (path: string, mime: string) => server(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, jsonb_build_object('mimetype', $2::text))`, [path, mime])
  const copyOf = async (post: string) => (await server(`select display_path from public.post_media where post_id = $1`, [post]))[0].display_path

  it('setup: a published video post each for two members (real upload rule)', async () => {
    await db.exec(`reset role; drop trigger if exists aa_test_simulate_upload on public.posts; drop trigger if exists aa_test_simulate_upload on public.post_media;`)
    a = await mk('m35a'); b = await mk('m35b')
    await upload(`${a}/v.mp4`, 'video/mp4'); await upload(`${b}/v.mp4`, 'video/mp4')
    pid = (await as(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'video') returning id`, [`${a}/v.mp4`]))[0].id
    await as(a, `insert into public.post_media (post_id, path, type, sort) values ($1, $2, 'video', 0)`, [pid, `${a}/v.mp4`])
    pidB = (await as(b, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'video') returning id`, [`${b}/v.mp4`]))[0].id
    await as(b, `insert into public.post_media (post_id, path, type, sort) values ($1, $2, 'video', 0)`, [pidB, `${b}/v.mp4`])
  })

  it('the author attaches a finished smaller copy after publishing', async () => {
    await upload(`${a}/small.webm`, 'video/webm')
    await as(a, `update public.post_media set display_path = $2 where post_id = $1`, [pid, `${a}/small.webm`])
    expect(await copyOf(pid)).toBe(`${a}/small.webm`)
  })

  it('refused: an unfinished upload, a photo as a video copy, the original itself, someone else\'s file', async () => {
    await fails(a, `update public.post_media set display_path = $2 where post_id = $1`, [pid, `${a}/never-uploaded.webm`])
    await upload(`${a}/still.webp`, 'image/webp')
    await fails(a, `update public.post_media set display_path = $2 where post_id = $1`, [pid, `${a}/still.webp`])
    await fails(a, `update public.post_media set display_path = $2 where post_id = $1`, [pid, `${a}/v.mp4`])
    await upload(`${b}/small.webm`, 'video/webm')
    await fails(a, `update public.post_media set display_path = $2 where post_id = $1`, [pid, `${b}/small.webm`])
    expect(await copyOf(pid)).toBe(`${a}/small.webm`)
  })

  it('nobody else can set or change the copy, and the author can change nothing but the copy', async () => {
    await upload(`${a}/small2.webm`, 'video/webm')
    await as(a, `update public.post_media set display_path = $2 where post_id = $1`, [pidB, `${a}/small2.webm`])   // not their row: no effect
    expect(await copyOf(pidB)).toBeNull()
    await as(b, `update public.post_media set display_path = null where post_id = $1`, [pid])                       // not their row: no effect
    expect(await copyOf(pid)).toBe(`${a}/small.webm`)
    await fails(a, `update public.post_media set path = $2 where post_id = $1`, [pid, `${a}/small2.webm`])
    await fails(a, `update public.post_media set type = 'image' where post_id = $1`, [pid])
  })

  it('photos keep their display copy rule (an image), and the author can remove a copy', async () => {
    await upload(`${a}/p.jpg`, 'image/jpeg'); await upload(`${a}/p-small.webp`, 'image/webp')
    const ip = (await as(a, `insert into public.posts (author, body, media_path, media_type) values (auth.uid(), '', $1, 'image') returning id`, [`${a}/p.jpg`]))[0].id
    await fails(a, `insert into public.post_media (post_id, path, type, sort, display_path) values ($1, $2, 'image', 0, $3)`, [ip, `${a}/p.jpg`, `${a}/small2.webm`])
    expect(await as(a, `insert into public.post_media (post_id, path, type, sort, display_path) values ($1, $2, 'image', 0, $3) returning post_id`, [ip, `${a}/p.jpg`, `${a}/p-small.webp`])).toHaveLength(1)
    await as(a, `update public.post_media set display_path = null where post_id = $1`, [pid])
    expect(await copyOf(pid)).toBeNull()
  })
})



describe('migration 36: sponsored posts (boost)', () => {
  let a = '', b = '', c = '', d = '', adminId = '', post = '', ev = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  let n = 0
  // The hourly order limit is tested on its own; everything else ages earlier orders first so it never gets in the way.
  const age = () => server(`update public.sponsor_orders set created_at = created_at - interval '3 hours'`)
  const order = async (who: string, o: Partial<{ post: string; pkg: string; goal: string; label: string | null; url: string | null; city: string | null; ints: string[]; provider: string; idem: string }> = {}) =>
    await age().then(() => as(who, `select public.create_sponsor_order($1, $2, $3, $4, $5, $6, $7, $8, $9) as r`, [o.post ?? post, o.pkg ?? 'boost_7', o.goal ?? 'engage', o.label ?? null, o.url ?? null, o.city ?? null, o.ints ?? [], o.provider ?? 'payfast', o.idem ?? `idem-${++n}-${Math.random()}`]).then(r => r[0].r as { id: string; sponsorship_id: string; status: string; total_cents: number }))
  const state = async (sid: string) => (await server(`select * from public.sponsored_posts where id = $1`, [sid]))[0]
  const feed = async (who: string) => (await as(who, `select public.sponsored_feed('home', 4) as f`))[0].f as { id: string; post_id: string }[]
  const pay = async (o: { id: string; total_cents: number }, ref = `pf-${Math.random()}`) => { await server(`select public.fulfill_sponsor_order($1, 'payfast', $2, $3)`, [o.id, ref, o.total_cents]) }
  const newPost = async (who: string, body = 'hello', extra = '') => (await as(who, `insert into public.posts (author, body ${extra ? ', ' + extra.split('=')[0] : ''}) values (auth.uid(), $1 ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [body]))[0].id

  it('setup: a sponsor, a viewer, a blocker, an admin, a public post and a plan', async () => {
    await db.exec(`reset role; drop trigger if exists aa_test_simulate_upload on public.posts; drop trigger if exists aa_test_simulate_upload on public.post_media;`)
    a = await mk('m36a'); b = await mk('m36b'); c = await mk('m36c'); d = await mk('m36d'); adminId = await mk('m36admin')
    await server(`insert into public.staff (user_id, role) values ($1, 'admin')`, [adminId])
    post = await newPost(a, 'Summer party this Saturday!')
    ev = (await as(a, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Party', now() + interval '3 day') returning id`))[0].id
    await as(a, `update public.profiles set display_name = 'Sponsor A' where id = auth.uid()`)
  })

  it('priced on the server from the package, idempotent per key, and sponsors cannot write boost tables directly', async () => {
    const idem = 'idem-fixed-12345'
    const o1 = await order(a, { idem })
    expect(o1.total_cents).toBe(19900); expect(o1.status).toBe('pending')
    const again = await order(a, { idem })
    expect(again.id).toBe(o1.id)
    await fails(a, `insert into public.sponsored_posts (post_id, sponsor, package_id, days, total_cents, status) values ($1, auth.uid(), 'boost_3', 3, 500, 'live')`, [post])
    await fails(a, `update public.sponsored_posts set status = 'live' where id = $1`, [o1.sponsorship_id])
    await fails(a, `update public.sponsor_orders set total_cents = 500, status = 'paid' where id = $1`, [o1.id])
    await fails(a, `select public.fulfill_sponsor_order($1, 'payfast', 'x', 19900)`, [o1.id])
    await as(a, `select public.stop_sponsorship($1)`, [o1.sponsorship_id])      // abandon so the next test starts clean
  })

  it('refused: someone else\'s post, a friends-only post, a bad link, a plan goal without a plan, an unknown package, a second boost', async () => {
    await fails(b, `select public.create_sponsor_order($1, 'boost_7', 'engage', null, null, null, '{}', 'payfast', 'idem-other-1234')`, [post])
    const fp = await newPost(a, 'friends only', "visibility='friends'")
    await fails(a, `select public.create_sponsor_order($1, 'boost_7', 'engage', null, null, null, '{}', 'payfast', 'idem-friends-12')`, [fp])
    await fails(a, `select public.create_sponsor_order($1, 'boost_7', 'link', null, 'http://insecure.example.com', null, '{}', 'payfast', 'idem-link-12345')`, [post])
    await fails(a, `select public.create_sponsor_order($1, 'boost_7', 'link', null, 'javascript:alert(1)', null, '{}', 'payfast', 'idem-js-1234567')`, [post])
    await fails(a, `select public.create_sponsor_order($1, 'boost_7', 'plan', null, null, null, '{}', 'payfast', 'idem-plan-12345')`, [post])
    await fails(a, `select public.create_sponsor_order($1, 'nope', 'engage', null, null, null, '{}', 'payfast', 'idem-pkg-123456')`, [post])
    const o = await order(a)
    await fails(a, `select public.create_sponsor_order($1, 'boost_3', 'engage', null, null, null, '{}', 'payfast', 'idem-dup-1234567')`, [post])
    await as(a, `select public.stop_sponsorship($1)`, [o.sponsorship_id])
  })

  it('nothing is shown before payment and review; payment only moves it to review; amounts and providers must match', async () => {
    const o = await order(a, { goal: 'link', url: 'https://tickets.example.com/party', label: 'Get tickets' })
    expect(await feed(b)).toHaveLength(0)
    await expect(server(`select public.fulfill_sponsor_order($1, 'payfast', 'x', 100)`, [o.id])).rejects.toThrow(/Amount mismatch/)
    await expect(server(`select public.fulfill_sponsor_order($1, 'ozow', 'x', $2)`, [o.id, o.total_cents])).rejects.toThrow(/Provider mismatch/)
    await pay(o)
    await pay(o)                                                              // a repeated notification changes nothing
    expect((await state(o.sponsorship_id)).status).toBe('in_review')
    expect(await feed(b)).toHaveLength(0)
    await fails(a, `select public.admin_review_sponsorship($1, true, null)`, [o.sponsorship_id])
    await fails(b, `select public.admin_review_sponsorship($1, true, null)`, [o.sponsorship_id])
    await as(adminId, `select public.admin_review_sponsorship($1, true, 'Looks fine')`, [o.sponsorship_id])
    const s = await state(o.sponsorship_id)
    expect(s.status).toBe('live'); expect(new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()).toBe(7 * 86400_000)
    expect((await as(a, `select type from public.notifications where entity_id = $1 and type = 'sponsorship'`, [post])).length).toBeGreaterThan(0)
    // kept for the following tests
    ;(globalThis as any).__live = o
  })

  it('delivery: shown to others (not the sponsor, not a blocker), once hidden never again, capped at three impressions a day', async () => {
    const o = (globalThis as any).__live
    expect((await feed(b)).map(x => x.id)).toContain(o.sponsorship_id)
    expect(await feed(a)).toHaveLength(0)                                       // never your own
    await as(d, `insert into public.blocks (blocker, blocked) values (auth.uid(), $1)`, [a])
    expect(await feed(d)).toHaveLength(0)                                       // d blocked the sponsor
    for (let i = 0; i < 3; i++) expect((await as(b, `select public.track_sponsored($1, 'impression') as t`, [o.sponsorship_id]))[0].t).toBe(true)
    expect((await as(b, `select public.track_sponsored($1, 'impression') as t`, [o.sponsorship_id]))[0].t).toBe(false)
    expect(await feed(b)).toHaveLength(0)                                       // frequency cap reached
    expect((await as(c, `select public.track_sponsored($1, 'click') as t`, [o.sponsorship_id]))[0].t).toBe(true)
    expect((await as(c, `select public.track_sponsored($1, 'click') as t`, [o.sponsorship_id]))[0].t).toBe(false)   // one click a day
    expect((await as(a, `select public.track_sponsored($1, 'impression') as t`, [o.sponsorship_id]))[0].t).toBe(false) // sponsors cannot inflate their own numbers
    await as(c, `select public.hide_sponsored($1)`, [o.sponsorship_id])
    expect(await feed(c)).toHaveLength(0)
  })

  it('insights: the sponsor reads real counts; nobody else reads them, the boost, or the order', async () => {
    const o = (globalThis as any).__live
    const st = await as(a, `select sum(impressions)::int i, sum(clicks)::int c, sum(reach)::int r from public.sponsor_stats where sponsored_id = $1`, [o.sponsorship_id])
    expect(st[0]).toEqual({ i: 3, c: 1, r: 1 })
    expect(await as(b, `select 1 from public.sponsor_stats where sponsored_id = $1`, [o.sponsorship_id])).toHaveLength(0)
    expect(await as(b, `select 1 from public.sponsored_posts`)).toHaveLength(0)
    expect(await as(b, `select 1 from public.sponsor_orders`)).toHaveLength(0)
    expect((await as(a, `select 1 from public.sponsored_posts where id = $1`, [o.sponsorship_id])).length).toBe(1)
    await fails(null, `select public.sponsored_feed('home', 2)`)
    await fails(b, `select public.admin_sponsorship_queue()`)
  })

  it('pausing stops delivery and gives the paused time back; stopping a live boost ends it with no refund', async () => {
    const o = (globalThis as any).__live
    const before = new Date((await state(o.sponsorship_id)).ends_at).getTime()
    await as(a, `select public.pause_sponsorship($1, true)`, [o.sponsorship_id])
    await server(`update public.sponsored_posts set paused_at = now() - interval '2 hour' where id = $1`, [o.sponsorship_id])
    await as(a, `select public.pause_sponsorship($1, false)`, [o.sponsorship_id])
    const s = await state(o.sponsorship_id)
    expect(s.status).toBe('live'); expect(new Date(s.ends_at).getTime() - before).toBeGreaterThan(2 * 3600_000 - 5000)
    await fails(b, `select public.pause_sponsorship($1, true)`, [o.sponsorship_id])
    await as(a, `select public.stop_sponsorship($1)`, [o.sponsorship_id])
    const e = await state(o.sponsorship_id)
    expect(e.status).toBe('ended'); expect(Number(e.refund_due_cents)).toBe(0)
  })

  it('rejection records a refund due, needs a reason, and an admin records the provider reference once', async () => {
    const o = await order(a, { pkg: 'boost_3' }); await pay(o)
    await expect(as(adminId, `select public.admin_review_sponsorship($1, false, '')`, [o.sponsorship_id])).rejects.toThrow(/why/)
    await as(adminId, `select public.admin_review_sponsorship($1, false, 'Misleading claim')`, [o.sponsorship_id])
    const s = await state(o.sponsorship_id)
    expect(s.status).toBe('rejected'); expect(Number(s.refund_due_cents)).toBe(9900)
    expect(await feed(b)).toHaveLength(0)
    const q = (await as(adminId, `select public.admin_sponsorship_queue() as q`))[0].q as { id: string; refund_due_cents: number }[]
    expect(q.find(x => x.id === o.sponsorship_id)?.refund_due_cents).toBe(9900)
    await fails(a, `select public.admin_mark_sponsor_refunded($1, 'PF-1')`, [o.sponsorship_id])
    await expect(as(adminId, `select public.admin_mark_sponsor_refunded($1, '')`, [o.sponsorship_id])).rejects.toThrow()
    await as(adminId, `select public.admin_mark_sponsor_refunded($1, 'PF-REFUND-1')`, [o.sponsorship_id])
    await expect(as(adminId, `select public.admin_mark_sponsor_refunded($1, 'PF-REFUND-2')`, [o.sponsorship_id])).rejects.toThrow(/Nothing to refund/)
    expect(((await as(adminId, `select public.admin_sponsorship_queue() as q`))[0].q as { id: string }[]).some(x => x.id === o.sponsorship_id)).toBe(false)
  })

  it('cancelling a paid, undelivered boost makes the full amount refund-due; an expired checkout closes cleanly; late payment is refund-due', async () => {
    const o = await order(a, { pkg: 'boost_14' }); await pay(o)
    await as(a, `select public.stop_sponsorship($1)`, [o.sponsorship_id])
    let s = await state(o.sponsorship_id)
    expect(s.status).toBe('cancelled'); expect(Number(s.refund_due_cents)).toBe(34900)
    const e = await order(a)
    await server(`select public.close_sponsor_order($1, 'expired')`, [e.id])
    expect((await state(e.sponsorship_id)).status).toBe('cancelled')
    await pay(e)                                                                 // the money arrives after the checkout was closed
    s = await state(e.sponsorship_id)
    expect(s.status).toBe('cancelled'); expect(Number(s.refund_due_cents)).toBe(19900)
    // and the post can be boosted again afterwards
    const again = await order(a); expect(again.status).toBe('pending')
    await as(a, `select public.stop_sponsorship($1)`, [again.sponsorship_id])
  })

  it('audience: city and interests are respected', async () => {
    await as(b, `update public.profiles set location = 'Cape Town, South Africa', interests = array['Music'] where id = auth.uid()`)
    await as(c, `update public.profiles set location = 'Durban, South Africa', interests = array['Food'] where id = auth.uid()`)
    const o = await order(a, { city: 'Cape Town', ints: ['music', 'Art'] }); await pay(o)
    await as(adminId, `select public.admin_review_sponsorship($1, true, null)`, [o.sponsorship_id])
    expect((await feed(b)).map(x => x.id)).toContain(o.sponsorship_id)
    expect((await feed(c)).map(x => x.id)).not.toContain(o.sponsorship_id)
    const why = (await as(b, `select public.sponsored_why($1) as w`, [o.sponsorship_id]))[0].w
    expect(why.city).toBe('Cape Town'); expect(why.sponsor_name).toBe('Sponsor A')
    await as(a, `select public.stop_sponsorship($1)`, [o.sponsorship_id])
  })

  it('an ad stops being served if the post stops being public, and a plan goal needs a real plan', async () => {
    const p2 = await newPost(a, 'Plan promo')
    await as(a, `update public.posts set event_id = $2 where id = $1`, [p2, ev]).catch(() => null)
    await server(`update public.posts set event_id = $2 where id = $1`, [p2, ev])
    const o = await order(a, { post: p2, goal: 'plan' }); await pay(o)
    await as(adminId, `select public.admin_review_sponsorship($1, true, null)`, [o.sponsorship_id])
    expect((await feed(b)).map(x => x.post_id)).toContain(p2)
    await as(a, `update public.posts set visibility = 'friends' where id = $1`, [p2])
    expect((await feed(b)).map(x => x.post_id)).not.toContain(p2)
  })

  it('at most five orders an hour per member', async () => {
    await age()
    const p3 = await newPost(a, 'rate limit post')
    for (let i = 0; i < 5; i++) await as(a, `select public.create_sponsor_order($1, 'boost_3', 'engage', null, null, null, '{}', 'payfast', $2)`, [p3, `idem-rate-${i}-${Math.random()}`]).then(() => server(`update public.sponsored_posts set status = 'cancelled' where post_id = $1`, [p3]))
    await fails(a, `select public.create_sponsor_order($1, 'boost_3', 'engage', null, null, null, '{}', 'payfast', 'idem-rate-over-1')`, [p3])
  })

  it('the packaged update (supabase/manual/update-36/run-me.sql) applies cleanly and every check row is true', async () => {
    await db.exec('reset role')
    const results = await db.exec(readFileSync(new URL('../../supabase/manual/update-36/run-me.sql', import.meta.url), 'utf8'))
    const rows = results[results.length - 1].rows as { item: string; ok: boolean }[]
    expect(rows.length).toBeGreaterThanOrEqual(7)
    expect(rows.filter(r => r.ok !== true).map(r => r.item)).toEqual([])
  })
})


describe('migration 37: rotating, signed ticket QR', () => {
  let host = '', holder = '', other = '', scanner = '', admin37 = '', ev = '', ev2 = '', tt = '', tk = { id: '', code: '' }, tk2 = { id: '', code: '' }
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const admit = async (event: string, code: string) => (await as(scanner, `select public.admit_ticket($1, $2) as r`, [event, code]))[0].r as { result: string; holder?: string }
  const qr = async (who: string, id: string, n = 1) => (await as(who, `select public.my_ticket_qr($1, $2) as q`, [id, n]))[0].q as { tokens: { w: number; token: string }[]; static_ok: boolean } | null
  const mkTicket = async (event: string, owner: string, i: number) => {
    const o = (await server(`insert into public.orders (buyer, event_id, status, provider, subtotal_cents, fee_cents, total_cents, idempotency_key, expires_at, paid_at) values ($1, $2, 'paid', 'free', 0, 0, 0, $3, now() + interval '1 hour', now()) returning id`, [owner, event, `qr37-order-${i}-${Math.random()}`]))[0].id
    return (await server(`insert into public.tickets (order_id, event_id, ticket_type_id, owner, code) values ($1, $2, $3, $4, upper(substr(md5(random()::text || clock_timestamp()::text), 1, 20))) returning id, code`, [o, event, tt, owner]))[0] as { id: string; code: string }
  }

  it('setup: an event with a door team, two tickets, and a second event', async () => {
    host = await mk('m37host'); holder = await mk('m37holder'); other = await mk('m37other'); scanner = await mk('m37scan'); admin37 = await mk('m37admin')
    await server(`insert into public.staff (user_id, role) values ($1, 'admin')`, [admin37])
    ev = (await as(host, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Night one', now() + interval '1 day') returning id`))[0].id
    ev2 = (await as(host, `insert into public.events (host, title, starts_at) values (auth.uid(), 'Night two', now() + interval '2 day') returning id`))[0].id
    tt = (await as(host, `insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order) values ($1, 'GA', 0, 50, 5) returning id`, [ev]))[0].id
    await as(host, `insert into public.event_staff (event_id, user_id, added_by) values ($1, $2, auth.uid())`, [ev, scanner])
    await as(host, `insert into public.event_staff (event_id, user_id, added_by) values ($1, $2, auth.uid())`, [ev2, scanner])
    tk = await mkTicket(ev, holder, 1); tk2 = await mkTicket(ev, holder, 2)
  })

  it('only the holder of a valid ticket gets tokens; the secret and signing function are unreachable', async () => {
    expect(await qr(other, tk.id)).toBeNull()
    expect(await qr(host, tk.id)).toBeNull()                                  // organisers never get a holder's QR
    const q = await qr(holder, tk.id, 3)
    expect(q!.tokens).toHaveLength(3); expect(q!.static_ok).toBe(true)
    expect(q!.tokens[0].token).toMatch(/^VYBE2:[0-9a-f-]{36}:\d+:[0-9a-f]{20}$/)
    expect(q!.tokens[1].w).toBe(q!.tokens[0].w + 1)
    expect((await qr(holder, tk.id, 999))!.tokens).toHaveLength(24)           // capped
    await fails(holder, `select * from public.qr_secret`)
    await fails(holder, `select public.qr_sig($1::uuid, 1)`, [tk.id])
    await fails(null, `select public.my_ticket_qr($1, 1)`, [tk.id])
  })

  it('a current token admits exactly once, in the right event only; replaying it says already used', async () => {
    const token = (await qr(holder, tk.id))!.tokens[0].token
    expect((await admit(ev2, token)).result).toBe('wrong_event')              // a genuine ticket, for another event
    const first = await admit(ev, token)
    expect(first.result).toBe('ok'); expect(first.holder).toBeTruthy()
    expect((await admit(ev, token)).result).toBe('already_used')
    expect((await admit(ev, tk.code)).result).toBe('already_used')            // and the static code cannot get it in again either
    expect(await qr(holder, tk.id)).toBeNull()                                // a used ticket no longer yields a QR
  })

  it('tampered tokens are refused: another ticket id, another window, a changed signature, junk', async () => {
    const good = (await qr(holder, tk2.id))!.tokens[0].token.split(':')
    const bad = (parts: string[]) => admit(ev, parts.join(':'))
    expect((await bad([good[0], tk.id, good[2], good[3]])).result).toBe('invalid')                  // swap in someone else's ticket id
    expect((await bad([good[0], good[1], String(Number(good[2]) + 1), good[3]])).result).toBe('invalid')    // shift the window
    expect((await bad([good[0], good[1], good[2], good[3].replace(/.$/, c => (c === '0' ? '1' : '0'))])).result).toBe('invalid')   // flip one signature character
    expect((await bad([good[0], good[1], good[2]])).result).toBe('invalid')
    expect((await bad(['VYBE2', 'not-a-uuid', '1', 'abc'])).result).toBe('invalid')
    expect((await admit(ev, 'VYBE2:')).result).toBe('invalid')
    expect((await server(`select status from public.tickets where id = $1`, [tk2.id]))[0].status).toBe('valid')   // none of that touched the ticket
  })

  it('a token from the past or the future (a screenshot) is refused as expired, and the ticket stays valid', async () => {
    // Genuine signatures for windows far from now, obtained the only way possible: from the database itself.
    const old = (await server(`select 'VYBE2:' || $1::text || ':' || (floor(extract(epoch from now()) / 30)::bigint - 5)::text || ':' || public.qr_sig($1::uuid, floor(extract(epoch from now()) / 30)::bigint - 5) as t`, [tk2.id]))[0].t
    expect((await admit(ev, old)).result).toBe('expired_qr')
    const future = (await server(`select 'VYBE2:' || $1::text || ':' || (floor(extract(epoch from now()) / 30)::bigint + 5)::text || ':' || public.qr_sig($1::uuid, floor(extract(epoch from now()) / 30)::bigint + 5) as t`, [tk2.id]))[0].t
    expect((await admit(ev, future)).result).toBe('expired_qr')
    const edge = (await server(`select 'VYBE2:' || $1::text || ':' || (floor(extract(epoch from now()) / 30)::bigint - 1)::text || ':' || public.qr_sig($1::uuid, floor(extract(epoch from now()) / 30)::bigint - 1) as t`, [tk2.id]))[0].t
    expect(['ok', 'expired_qr']).toContain((await admit(ev, edge)).result)  // one window back is tolerated (a window can tick over mid-scan)
  })

  it('door staff and strangers cannot forge or fish: a token for a ticket does not work for a non-scanner', async () => {
    const t3 = await mkTicket(ev, holder, 3)
    const token = (await qr(holder, t3.id))!.tokens[0].token
    expect((await as(other, `select public.admit_ticket($1, $2) as r`, [ev, token]))[0].r.result).toBe('forbidden')
    expect((await server(`select status from public.tickets where id = $1`, [t3.id]))[0].status).toBe('valid')
  })

  it('strict mode (admin switch): static codes and screenshots of them stop working; tokens still do; only admins can flip it', async () => {
    const t4 = await mkTicket(ev, holder, 4), t5 = await mkTicket(ev, holder, 5)
    await fails(host, `select public.admin_set_rotating_qr(true)`)
    await fails(holder, `select public.admin_set_rotating_qr(true)`)
    await as(admin37, `select public.admin_set_rotating_qr(true)`)
    expect((await qr(holder, t4.id))!.static_ok).toBe(false)
    expect((await admit(ev, t4.code)).result).toBe('static_code')
    expect((await admit(ev, `VYBE1:${t4.code}`)).result).toBe('static_code')
    expect((await server(`select status from public.tickets where id = $1`, [t4.id]))[0].status).toBe('valid')
    expect((await admit(ev, (await qr(holder, t4.id))!.tokens[0].token)).result).toBe('ok')
    // the older code-only entry point follows the same rules
    expect((await as(scanner, `select public.check_in_ticket($1) as r`, [t5.code]))[0].r.result).toBe('static_code')
    expect((await as(scanner, `select public.check_in_ticket($1) as r`, [(await qr(holder, t5.id))!.tokens[0].token]))[0].r.result).toBe('ok')
    await as(admin37, `select public.admin_set_rotating_qr(false)`)
    expect((await server(`select action from public.audit_log where action = 'tickets.rotating_qr'`)).length).toBe(2)
  })

  it('every attempt is logged with its outcome (including the new ones)', async () => {
    const seen = (await as(host, `select distinct result from public.ticket_scans where event_id = $1`, [ev])).map((r: any) => r.result)
    expect(seen).toEqual(expect.arrayContaining(['ok', 'already_used', 'invalid', 'expired_qr', 'static_code']))
  })

  it('the packaged update (supabase/manual/update-37/run-me.sql) applies cleanly and every check row is true', async () => {
    await db.exec('reset role')
    const results = await db.exec(readFileSync(new URL('../../supabase/manual/update-37/run-me.sql', import.meta.url), 'utf8'))
    const rows = results[results.length - 1].rows as { item: string; ok: boolean }[]
    expect(rows.length).toBeGreaterThanOrEqual(5)
    expect(rows.filter(r => r.ok !== true).map(r => r.item)).toEqual([])
  })
})

describe('migration 38: short motion profile pictures', () => {
  let me = '', other = ''
  const mk = async (n: string) => (await db.query<{ id: string }>(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${n}@example.com`, JSON.stringify({ username: n })])).rows[0].id
  const server = async (sql: string, params: any[] = []) => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`); return (await db.query<any>(sql, params)).rows }
  const clip = async (path: string, mimetype = 'video/mp4', size = 1_000_000) => { await server(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)`, [path, JSON.stringify({ mimetype, size })]) }

  it('setup', async () => { me = await mk('m38me'); other = await mk('m38other') })

  it('the owner can attach a finished clip from their own folder', async () => {
    const path = `${me}/clip1.mp4`; await clip(path)
    await as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [path])
    expect((await server(`select avatar_motion_path from public.profiles where id = $1`, [me]))[0].avatar_motion_path).toBe(path)
  })
  it('a clip that is not yours, not finished, the wrong type or too big is refused', async () => {
    const theirs = `${other}/clip.mp4`; await clip(theirs)
    await expect(as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [theirs])).rejects.toThrow(/own upload/)
    await expect(as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [`${me}/missing.mp4`])).rejects.toThrow(/finished uploading/)
    const img = `${me}/pic.png`; await clip(img, 'image/png')
    await expect(as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [img])).rejects.toThrow(/finished uploading/)
    const big = `${me}/big.mp4`; await clip(big, 'video/mp4', 20 * 1024 * 1024)
    await expect(as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [big])).rejects.toThrow(/finished uploading/)
  })
  it('nobody else can change it, and it can be removed', async () => {
    const r = await as(other, `update public.profiles set avatar_motion_path = null where id = $1 returning id`, [me])
    expect(r.length).toBe(0)
    expect((await server(`select avatar_motion_path from public.profiles where id = $1`, [me]))[0].avatar_motion_path).not.toBeNull()
    await as(me, `update public.profiles set avatar_motion_path = null where id = auth.uid()`)
    expect((await server(`select avatar_motion_path from public.profiles where id = $1`, [me]))[0].avatar_motion_path).toBeNull()
  })
  it('anyone signed in can read a member\'s clip through the media read rule', async () => {
    const path = `${me}/clip2.mp4`; await clip(path)
    await as(me, `update public.profiles set avatar_motion_path = $1 where id = auth.uid()`, [path])
    const seen = await as(other, `select name from storage.objects where bucket_id = 'media' and name = $1`, [path])
    expect(seen.length).toBe(1)
    await as(me, `update public.profiles set avatar_motion_path = null where id = auth.uid()`)
    expect((await as(other, `select name from storage.objects where bucket_id = 'media' and name = $1`, [path])).length).toBe(0)
  })
})
