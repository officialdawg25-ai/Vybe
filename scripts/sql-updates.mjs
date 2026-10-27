// Builds supabase/manual/update-19|20|21/run-me.sql: migrations 19, 20 and 21 as all-or-nothing files for the Supabase SQL
// editor. Each refuses to run until the migration before it is in place and ends with a table of checks.
// Usage: node scripts/sql-updates.mjs   (rerun after changing any of these migrations)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const UPDATES = [
  { n: 19, file: '20261101000019_org_portal.sql', title: 'Organisation Portal (identity, roles, history, overview)',
    need: ["(select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%l.image_path = objects.name%'", 'apply migrations 14-18 (supabase/manual/update-14-to-18) first.'],
    checks: [
      ['identity columns', "exists (select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'cover_path') and exists (select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'links')"],
      ['image and link guard', "exists (select 1 from pg_trigger where tgname = 'org_guard')"],
      ['audit triggers', "exists (select 1 from pg_trigger where tgname = 'org_audit') and exists (select 1 from pg_trigger where tgname = 'org_member_audit')"],
      ['portal functions (members only)', "has_function_privilege('authenticated', 'public.org_overview(uuid)', 'execute') and not has_function_privilege('anon', 'public.org_overview(uuid)', 'execute') and exists (select 1 from pg_proc where proname = 'set_org_member_role') and exists (select 1 from pg_proc where proname = 'org_activity')"],
      ['media read rule includes organisation logos and covers', "(select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%organizations%'"],
    ] },
  { n: 20, file: '20261102000020_org_communities_notifications_media.sql', title: 'Organisation communities, notification settings, media library',
    need: ["exists (select 1 from pg_trigger where tgname = 'org_guard')", 'apply migration 19 (supabase/manual/update-19) first.'],
    checks: [
      ['communities.organization_id', "exists (select 1 from information_schema.columns where table_name = 'communities' and column_name = 'organization_id')"],
      ['per-organisation notification settings', "exists (select 1 from information_schema.columns where table_name = 'organization_members' and column_name = 'notif_prefs') and exists (select 1 from pg_trigger where tgname = 'org_rsvp_notify')"],
      ['media library with server-only status', "to_regclass('public.media_assets') is not null and not has_column_privilege('authenticated', 'public.media_assets', 'status', 'update')"],
      ['video posters', "exists (select 1 from information_schema.columns where table_name = 'post_media' and column_name = 'poster_path')"],
    ] },
  { n: 21, file: '20261103000021_advisor_fixes.sql', title: 'Database advisor fixes (security and performance)',
    need: ["to_regclass('public.media_assets') is not null", 'apply migration 20 (supabase/manual/update-20) first.'],
    checks: [
      ['trigger functions not callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
      ['trg_friendship_lock search_path fixed', "(select proconfig from pg_proc where proname = 'trg_friendship_lock') is not null"],
      ['no policy evaluates auth.uid() per row', "not exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relnamespace = 'public'::regnamespace and (pg_get_expr(pol.polqual, pol.polrelid) ~ '(?<!SELECT )auth\\.uid\\(\\)' or pg_get_expr(pol.polwithcheck, pol.polrelid) ~ '(?<!SELECT )auth\\.uid\\(\\)'))"],
      ['every foreign key has an index', "not exists (select 1 from pg_constraint con join pg_class cls on cls.oid = con.conrelid where con.contype = 'f' and cls.relnamespace = 'public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid = con.conrelid and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] @> con.conkey and (i.indkey::int2[])[0:cardinality(con.conkey) - 1] <@ con.conkey))"],
    ] },
  { n: 22, file: '20261104000022_reels_live_usernames_music.sql', title: 'Reels, video notes, live notifications, usernames, admin music uploads',
    need: ["exists (select 1 from pg_policy where polname = 'media_select_visible') and to_regclass('public.media_assets') is not null", 'apply migrations 19-21 first.'],
    checks: [
      ['admin music uploads allowed again', "(select pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = 'brand_admin_insert') like '%music/%'"],
      ['reels', "exists (select 1 from information_schema.columns where table_name = 'posts' and column_name = 'is_reel')"],
      ['video notes', "exists (select 1 from information_schema.columns where table_name = 'comments' and column_name = 'video_path') and exists (select 1 from information_schema.columns where table_name = 'messages' and column_name = 'video_note')"],
      ['usernames', "exists (select 1 from pg_proc where proname = 'set_username') and has_function_privilege('anon', 'public.username_available(text)', 'execute')"],
      ['sign-in throttle table is server-only', "to_regclass('public.login_attempts') is not null and not has_table_privilege('authenticated', 'public.login_attempts', 'select')"],
    ] },
  { n: 23, file: '20261105000023_event_media_discover_tiles.sql', title: 'Event background media and Discover tile covers',
    need: ["exists (select 1 from information_schema.columns where table_name = 'comments' and column_name = 'video_path')", 'apply migration 22 (supabase/manual/update-22) first.'],
    checks: [
      ['event background video', "exists (select 1 from information_schema.columns where table_name = 'events' and column_name = 'hero_video_path')"],
      ['event media must be your own upload', "exists (select 1 from pg_trigger where tgname = 'event_media_guard')"],
      ['background video readable with the event', "(select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%hero_video_path%'"],
      ['Discover tile covers (admins only)', "to_regclass('public.discover_tiles') is not null and (select pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = 'brand_admin_insert') like '%discover/%'"],
    ] },
  { n: 24, file: '20261106000024_live_guests.sql', title: 'Group lives: guests on stage',
    need: ["to_regclass('public.discover_tiles') is not null", 'apply migration 23 (supabase/manual/update-23) first.'],
    checks: [
      ['guest list table (host and guest can read; nobody writes directly)', "to_regclass('public.live_guests') is not null and not has_table_privilege('authenticated', 'public.live_guests', 'insert')"],
      ['host-only stage control', "exists (select 1 from pg_proc where proname = 'live_guest_set') and exists (select 1 from pg_proc where proname = 'live_guest_leave')"],
      ['token gate knows guests', "(select prosrc from pg_proc where proname = 'live_token_gate') like '%guest%'"],
    ] },
  { n: 25, file: '20261107000025_media_speed_field_metrics.sql', title: 'Faster media checks, photo display copies, field performance numbers',
    need: ["to_regclass('public.live_guests') is not null", 'apply migration 24 (supabase/manual/update-24) first.'],
    checks: [
      ['file-path indexes for the media read rule', "(select count(*) from pg_indexes where schemaname = 'public' and indexname in ('posts_media_path_idx', 'post_media_path_idx', 'profiles_avatar_path_idx', 'comments_audio_path_idx', 'messages_media_path_idx', 'media_assets_org_path_idx')) = 6"],
      ['photo display copies readable with their post', "exists (select 1 from information_schema.columns where table_name = 'post_media' and column_name = 'display_path') and (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%display_path%'"],
      ['performance numbers: no direct access, no user id', "to_regclass('public.client_metrics') is not null and not has_table_privilege('authenticated', 'public.client_metrics', 'select') and not exists (select 1 from information_schema.columns where table_name = 'client_metrics' and column_name = 'user_id')"],
      ['performance functions for signed-in members only', "not has_function_privilege('anon', 'public.record_client_metrics(jsonb)', 'execute') and has_function_privilege('authenticated', 'public.client_metrics_summary(integer)', 'execute')"],
    ] },
  { n: 26, file: '20261108000026_story_music_reel_studio.sql', title: 'Memory studio (music, overlays, effects, Close Friends), reel settings, song lengths',
    need: ["to_regclass('public.client_metrics') is not null", 'apply migration 25 (supabase/manual/update-25) first.'],
    checks: [
      ['Close Friends list (owner only)', "to_regclass('public.close_friends') is not null and has_table_privilege('authenticated', 'public.close_friends', 'insert') and not has_table_privilege('anon', 'public.close_friends', 'select')"],
      ['memory song, overlays and effect', "(select count(*) from information_schema.columns where table_name = 'memories' and column_name in ('music_track_id', 'music_title', 'music_path', 'music_start_ms', 'overlays', 'filter')) = 6"],
      ['Close Friends audience understood by the visibility rule', "(select prosrc from pg_proc where proname = 'can_view_memory') like '%close_friends%'"],
      ['memory songs readable with their memory', "(select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%m.music_path%'"],
      ['reel settings and song lengths', "exists (select 1 from information_schema.columns where table_name = 'posts' and column_name = 'reel_edit') and exists (select 1 from information_schema.columns where table_name = 'music_tracks' and column_name = 'duration_ms')"],
    ] },
  { n: 27, file: '20261109000027_feed_suggestions.sql', title: 'Ranked Home feed suggestions (events, artists, people) with reasons',
    need: ["to_regclass('public.close_friends') is not null", 'apply migration 26 (supabase/manual/update-26) first.'],
    checks: [
      ['ranked suggestions for signed-in members only', "has_function_privilege('authenticated', 'public.feed_suggestions(double precision, double precision, integer)', 'execute') and not has_function_privilege('anon', 'public.feed_suggestions(double precision, double precision, integer)', 'execute')"],
      ['"Not interested" is private and written only through the function', "to_regclass('public.suggestion_dismissals') is not null and (select relrowsecurity from pg_class where oid = 'public.suggestion_dismissals'::regclass) and not has_table_privilege('authenticated', 'public.suggestion_dismissals', 'insert')"],
    ] },
  { n: 28, file: '20261110000028_tickets_trust_ledger.sql', title: 'VYBE Tickets: fee policies, sales review, double-entry journal, reconciliation, admission, payout controls',
    need: ["to_regclass('public.suggestion_dismissals') is not null", 'apply migration 27 (supabase/manual/update-27) first.'],
    checks: [
      ['launch terms carried over as fee policy v1 (buyer fee as before, no commission)', "exists (select 1 from public.fee_policies f, public.platform_config c where f.scope = 'platform' and f.buyer_fee_bps = c.fee_bps and f.buyer_fee_fixed_cents = c.fee_fixed_cents and f.commission_bps = 0)"],
      ['every journal entry balances', "not exists (select 1 from public.journal_lines group by entry_id having sum(amount_cents) <> 0)"],
      ['paid ticket sales need review; nobody can pre-approve their own event', "(select require_sales_review from public.platform_config) and exists (select 1 from pg_trigger where tgname = 'event_review_insert') and not has_column_privilege('authenticated', 'public.events', 'sales_review', 'update')"],
      ['ticket codes are no longer readable by organisers or scanners', "not has_column_privilege('authenticated', 'public.tickets', 'code', 'select') and has_function_privilege('authenticated', 'public.my_ticket_code(uuid)', 'execute')"],
      ['payment notifications and reconciliation are server-only', "not has_table_privilege('authenticated', 'public.payment_notifications', 'insert') and not has_function_privilege('authenticated', 'public.record_payment_notification(text, text, text, text, bigint, text)', 'execute')"],
      ['event-bound admission and door teams', "has_function_privilege('authenticated', 'public.admit_ticket(uuid, text)', 'execute') and to_regclass('public.event_staff') is not null and to_regclass('public.ticket_scans') is not null"],
      ['no trigger function callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
    ] },
  { n: 29, file: '20261111000029_tickets_risk_reviews_referrals.sql', title: 'VYBE Tickets: risk engine, payout holds, material changes, reviews and complaints, promoter referrals, exports',
    need: ["to_regclass('public.journal_entries') is not null", 'apply migration 28 (supabase/manual/update-28) first.'],
    checks: [
      ['finance views closed to outsiders (security fix)', "(select prosrc from pg_proc where proname = 'can_view_finance') like '%coalesce%'"],
      ['risk rules seeded; cases are admin-only', "(select count(*) from public.risk_rules) >= 10 and (select relrowsecurity from pg_class where oid = 'public.risk_cases'::regclass)"],
      ['risk signals cannot be raised over the API', "not has_function_privilege('authenticated', 'public.risk_signal(text, text, uuid, jsonb)', 'execute')"],
      ['reviews only through the eligibility check', "to_regclass('public.event_reviews') is not null and not has_table_privilege('authenticated', 'public.event_reviews', 'insert') and has_function_privilege('authenticated', 'public.submit_event_review(uuid, integer, text)', 'execute')"],
      ['complaints and promoter links', "to_regclass('public.event_complaints') is not null and to_regclass('public.promoter_links') is not null and has_function_privilege('authenticated', 'public.create_order(uuid, jsonb, text, text, text)', 'execute')"],
      ['journal knows promoter payable', "(select pg_get_constraintdef(oid) from pg_constraint where conname = 'journal_lines_account_known') like '%promoter_payable%'"],
      ['every journal entry balances', "not exists (select 1 from public.journal_lines group by entry_id having sum(amount_cents) <> 0)"],
      ['no trigger function callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
    ] },
  { n: 30, file: '20261112000030_tickets_commission_email_fees.sql', title: 'VYBE Tickets: organiser commission terms, processing fees, transactional email, payout failures',
    need: ["to_regclass('public.risk_rules') is not null", 'apply migration 29 (supabase/manual/update-29) first.'],
    checks: [
      ['new orders: 5 % organiser commission, no buyer fee', "exists (select 1 from public.fee_policies where scope = 'platform' and retired_at is null and commission_bps = 500 and not buyer_fee_enabled) and (select count(*) from public.fee_policies where scope = 'platform' and retired_at is null) = 1"],
      ['provider fees can be booked (server only)', "has_function_privilege('authenticated', 'public.record_processing_fee(uuid, text, text, bigint)', 'execute') = false and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'journal_lines_account_known') like '%processing_expense%'"],
      ['email queue closed to the API; worker key not reachable', "to_regclass('public.email_outbox') is not null and not has_table_privilege('anon', 'public.email_outbox', 'select') and not has_schema_privilege('authenticated', 'vybe_private', 'usage') and not has_function_privilege('authenticated', 'public.email_worker_claim(text, integer)', 'execute')"],
      ['admins can record a payout that could not be paid', "has_function_privilege('authenticated', 'public.admin_mark_payout_failed(uuid, text)', 'execute')"],
      ['every journal entry balances', "not exists (select 1 from public.journal_lines group by entry_id having sum(amount_cents) <> 0)"],
      ['no trigger function callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
    ] },
  { n: 31, file: '20261113000031_pg_net_schema.sql', title: 'Move pg_net out of the public schema',
    need: ["to_regclass('public.email_outbox') is not null", 'apply migration 30 (supabase/manual/update-30) first.'],
    checks: [
      ['pg_net is not in public', "not exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public')"],
      ['the email job can still call out', "not exists (select 1 from pg_extension where extname = 'pg_net') or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null"],
    ] },
  { n: 32, file: '20261114000032_post_song_start_comment_likes.sql', title: 'Where a post song starts, likes on comments',
    need: ["not exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public')", 'apply migration 31 (supabase/manual/update-31) first.'],
    checks: [
      ['post song start', "exists (select 1 from information_schema.columns where table_name = 'posts' and column_name = 'music_start_ms')"],
      ['comment likes: readable with the comment, written only by yourself', "to_regclass('public.comment_reactions') is not null and (select relrowsecurity from pg_class where oid = 'public.comment_reactions'::regclass) and not has_table_privilege('anon', 'public.comment_reactions', 'select') and not has_table_privilege('authenticated', 'public.comment_reactions', 'update')"],
      ['online status: friends only', "to_regclass('realtime.messages') is null or (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('vybe_online_listen', 'vybe_online_announce')) = 2"],
    ] },
  { n: 33, file: '20261115000033_ticket_branding_host_trust.sql', title: 'Branded ticket tiers, host trust card, email retries end',
    need: ["exists (select 1 from information_schema.columns where table_name = 'posts' and column_name = 'music_start_ms')", 'apply migration 32 (supabase/manual/update-32) first.'],
    checks: [
      ['ticket types carry tier, colour, design and perks', "(select count(*) from information_schema.columns where table_name = 'ticket_types' and column_name in ('tier', 'accent', 'design', 'perks')) = 4 and has_column_privilege('authenticated', 'public.ticket_types', 'tier', 'update')"],
      ['host card for signed-in members only', "has_function_privilege('authenticated', 'public.host_reputation(uuid)', 'execute') and not has_function_privilege('anon', 'public.host_reputation(uuid)', 'execute')"],
      ['no email stuck after its last attempt', "not exists (select 1 from public.email_outbox where status in ('pending', 'sending') and attempts >= 5)"],
    ] },
  { n: 34, file: '20261116000034_post_publishing_rules.sql', title: 'Publishing rules: no song-only posts, own finished uploads, no duplicate publish',
    need: ["exists (select 1 from information_schema.columns where table_name = 'ticket_types' and column_name = 'tier')", 'apply migration 33 (supabase/manual/update-33) first.'],
    checks: [
      ['a post needs meaningful text or a photo/video', "exists (select 1 from pg_constraint where conname = 'posts_has_meaningful_content' and convalidated) and not exists (select 1 from pg_constraint where conname = 'posts_has_content') and not public.meaningful_text(' … 🔥 ') and public.meaningful_text('Hi')"],
      ['a post only uses files its author uploaded', "exists (select 1 from pg_constraint where conname = 'posts_media_path_owner' and convalidated)"],
      ['unfinished uploads are refused', "exists (select 1 from pg_trigger where tgname = 'posts_media_uploaded') and exists (select 1 from pg_trigger where tgname = 'post_media_uploaded') and not has_function_privilege('authenticated', 'public.media_uploaded(text)', 'execute')"],
      ['a retried publish cannot duplicate', "exists (select 1 from pg_indexes where indexname = 'posts_author_client_key')"],
      ['no trigger function callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
    ] },
  { n: 35, file: '20261117000035_video_smaller_copy.sql', title: 'Smaller playback copy of a video (quality choice)',
    need: ["exists (select 1 from pg_indexes where indexname = 'posts_author_client_key')", 'apply migration 34 (supabase/manual/update-34) first.'],
    checks: [
      ['authors can set only the copy column', "has_column_privilege('authenticated', 'public.post_media', 'display_path', 'update') and not has_column_privilege('authenticated', 'public.post_media', 'path', 'update') and not has_column_privilege('authenticated', 'public.post_media', 'type', 'update') and exists (select 1 from pg_policies where tablename = 'post_media' and policyname = 'post_media_upd_display')"],
      ['the copy must be a finished upload of the right kind', "exists (select 1 from pg_trigger where tgname = 'post_media_display_ok')"],
      ['existing copies are all photos', "not exists (select 1 from public.post_media where display_path is not null and type <> 'image')"],
      ['no trigger function callable over the API', "not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))"],
    ] },
]

for (const u of UPDATES) {
  const body = readFileSync(new URL(`../supabase/migrations/${u.file}`, import.meta.url), 'utf8').trim()
  const text = `-- MIGRATION ${u.n}: ${u.title}
-- Generated by scripts/sql-updates.mjs from supabase/migrations/${u.file}; do not edit by hand.
-- Paste the WHOLE file into the Supabase SQL editor with nothing selected, then Run. Check the last line you pasted is
-- "-- END OF MIGRATION ${u.n}". It runs all or nothing and is safe to run again; the table at the end should say true on every row.

begin;

do $$ begin
  if not (${u.need[0]}) then
    raise exception 'Stopped before changing anything: ${u.need[1]}';
  end if;
end $$;

${body}

commit;

select item, ok from (values
${u.checks.map(([i, c]) => `  ('${i}', ${c})`).join(',\n')}
) as v(item, ok);
-- END OF MIGRATION ${u.n}
`
  mkdirSync(new URL(`../supabase/manual/update-${u.n}/`, import.meta.url), { recursive: true })
  writeFileSync(new URL(`../supabase/manual/update-${u.n}/run-me.sql`, import.meta.url), text)
  console.log(`update-${u.n}/run-me.sql: ${text.split('\n').length} lines`)
}
