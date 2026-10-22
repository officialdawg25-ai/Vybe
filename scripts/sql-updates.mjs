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
