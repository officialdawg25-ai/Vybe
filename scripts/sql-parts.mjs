// Builds supabase/manual/update-14-to-18/part-1…5: migrations 14–18 as five smaller files for the Supabase SQL editor
// (a single ~500-line file is easy to paste only partly, especially on a phone).
//  * Each part is one transaction (all or nothing), refuses to run until the part before it has run, and ends with checks.
//  * Duplicates keep the later, more advanced definition: the notification types from migration 16 (which include 14's
//    'security') are set once, in part 1; 16's identical statement is left out of part 4.
//  * Every function's permissions are set in the same part that creates it.
// Usage: node scripts/sql-parts.mjs   (rerun after changing any of migrations 14–18)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'

const m = f => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')
const m14 = m('20261027000014_chat_security_groups.sql'), m15 = m('20261028000015_posts_names.sql'), m16 = m('20261029000016_campaigns.sql')
const m17 = m('20261030000017_profile_privacy.sql'), m18 = m('20261031000018_media_policy_anon_helpers.sql')
const cut = (s, from, to) => { const a = s.indexOf(from), b = to ? s.indexOf(to, a) : s.length; if (a < 0 || b < 0) throw new Error(`marker not found: ${from} / ${to}`); return s.slice(a, b) }
const NOTIF = cut(m16, 'alter table public.notifications drop constraint if exists notifications_type_check;', 'create or replace function public.promo_audit()')

const keys = cut(m14, '-- ---------------------------------------------------------------- audit trail', '-- ---------------------------------------------------------------- end-to-end encrypted groups')
const groups = cut(m14, '-- ---------------------------------------------------------------- end-to-end encrypted groups', '\nrevoke execute on function public.publish_chat_key')
const keyGrants = `revoke execute on function public.publish_chat_key(text, jsonb, jsonb), public.update_chat_backups(jsonb, jsonb), public.cancel_recovery_request(uuid), public.expire_recovery_requests() from public, anon;
grant execute on function public.publish_chat_key(text, jsonb, jsonb), public.update_chat_backups(jsonb, jsonb), public.cancel_recovery_request(uuid), public.expire_recovery_requests() to authenticated;
${cut(m14, 'revoke execute on function public.chat_security_event', null).trim()}`
const groupGrants = `revoke execute on function public.start_group_encryption(uuid), public.group_key_status(uuid, integer) from public, anon;
grant execute on function public.start_group_encryption(uuid), public.group_key_status(uuid, integer) to authenticated;`
const m16body = m16.replace(NOTIF, '-- (Notification types were already set in part 1.)\n')

const need = (cond, msg) => `do $$ begin\n  if not (${cond}) then raise exception 'Stopped before changing anything: ${msg}'; end if;\nend $$;`
const ok = items => `select item, ok from (values\n${items.map(([i, c]) => `  ('${i}', ${c})`).join(',\n')}\n) as v(item, ok);`

const parts = [
  { title: 'Chat keys, key backups, recovery and security alerts (migration 14, first half)', guard: readFileSync(new URL('./combine-preflight.sql', import.meta.url), 'utf8').trim(),
    body: `${NOTIF.trim()}\n\n${keys.trim()}\n\n${keyGrants}`,
    checks: [['chat key functions', "exists (select 1 from pg_proc where proname = 'publish_chat_key') and exists (select 1 from pg_proc where proname = 'update_chat_backups')"],
             ['recovery tables', "to_regclass('public.chat_recovery_requests') is not null and to_regclass('public.chat_key_escrow') is not null and to_regclass('public.chat_key_events') is not null"],
             ['notification types include security and campaign', "pg_get_constraintdef((select oid from pg_constraint where conname = 'notifications_type_check')) like '%security%campaign%'"]] },
  { title: 'End-to-end encrypted groups (migration 14, second half)', guard: need("exists (select 1 from pg_proc where proname = 'publish_chat_key')", 'run part 1 first.'),
    body: `${groups.trim()}\n\n${groupGrants}`,
    checks: [['group encryption', "to_regclass('public.conversation_keys') is not null and exists (select 1 from pg_trigger where tgname = 'message_encryption')"]] },
  { title: 'Song-only posts and the 14-day name rule (migration 15)', guard: need("to_regclass('public.conversation_keys') is not null", 'run part 2 first.'),
    body: m15.trim(),
    checks: [['posts_has_content replaces posts_check', "exists (select 1 from pg_constraint where conname = 'posts_has_content') and not exists (select 1 from pg_constraint where conname = 'posts_check' and conrelid = 'public.posts'::regclass)"],
             ['14-day name rule', "exists (select 1 from pg_trigger where tgname = 'trg_limit_display_name')"]] },
  { title: 'Campaigns for Home and Discover, organisation submissions and review (migration 16)', guard: need("exists (select 1 from pg_trigger where tgname = 'trg_limit_display_name')", 'run part 3 first.'),
    body: m16body.trim(),
    checks: [['campaign columns', "exists (select 1 from information_schema.columns where table_name = 'promo_slides' and column_name = 'placements')"],
             ['campaign rules', "exists (select 1 from pg_trigger where tgname = 'trg_promo_guard') and exists (select 1 from pg_trigger where tgname = 'trg_promo_audit')"]] },
  { title: 'Profile privacy, media read fix, helpers not callable signed out (migrations 17 and 18)', guard: need("exists (select 1 from pg_trigger where tgname = 'trg_promo_guard')", 'run part 4 first.'),
    body: `${m17.trim()}\n\n${m18.trim()}`,
    checks: [['profiles private columns hidden', "not has_column_privilege('authenticated', 'public.profiles', 'lat', 'select') and has_column_privilege('authenticated', 'public.profiles', 'display_name', 'select')"],
             ['my_profile()', "exists (select 1 from pg_proc where proname = 'my_profile')"],
             ['media read rule reads objects.name', "(select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'media_select_visible') like '%l.image_path = objects.name%'"],
             ['signed-out visitors cannot call the visibility helpers', "not has_function_privilege('anon', 'public.are_friends(uuid, uuid)', 'execute') and has_function_privilege('authenticated', 'public.are_friends(uuid, uuid)', 'execute')"]] },
]

const dir = new URL('../supabase/manual/update-14-to-18/', import.meta.url)
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
parts.forEach((p, i) => {
  const n = i + 1
  const text = `-- PART ${n} OF ${parts.length}: ${p.title}
-- Generated by scripts/sql-parts.mjs from the migrations; do not edit by hand.
-- Paste the WHOLE file into the Supabase SQL editor with nothing selected, then Run. Check the last line you pasted is
-- "-- END OF PART ${n}". It runs all or nothing and is safe to run again; the table at the end should say true on every row.

begin;

${p.guard}

${p.body}

commit;

${ok(p.checks.map(([a, b]) => [`part ${n}: ${a}`, b]))}
-- END OF PART ${n}
`
  writeFileSync(new URL(`part-${n}.sql`, dir), text)
  console.log(`part-${n}.sql: ${text.split('\n').length} lines`)
})
