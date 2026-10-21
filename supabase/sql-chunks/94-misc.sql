-- Migration 18 (written as "migration 14" on main, renumbered when the two branches were merged: this repository's
-- 20261027000014 is the chat security migration). Additive and re-runnable; no data is rewritten.
--
-- 1. Media read policy: in the lineup and community sub-queries the unqualified `name` bound to event_lineup.name and
--    communities.name (both tables have a `name` column), so `l.image_path = name` compared the image path with the act's own
--    name and never matched. Lineup images and community covers were therefore unreadable to everyone except their uploader.
--    Every reference is now qualified as objects.name. Nothing else changes: each sub-query still runs under the reader's RLS,
--    so a file is readable only when a row the reader may see points at it.
--
-- 2. (Removed in the merge.) Main's single `placement` and `label` columns are superseded by migration 16, which adds
--    `placements` (a slide may show in both places), `kind` and organisation campaigns. Keeping both would give the same
--    slide two contradicting sources of truth.
--
-- 3. Signed-out callers could run the visibility helpers over /rest/v1/rpc (the Supabase advisor flags 32 SECURITY DEFINER
--    functions executable by anon). Most only consult auth.uid() and return nothing useful to anon, but are_friends(a, b) and
--    is_blocked(a, b) answered for ANY two member ids. Anon has no table grants and no policy anon can reach calls these helpers,
--    so EXECUTE is moved from PUBLIC/anon to authenticated (and service_role). get_auth_hero() stays public: the signed-out
--    sign-in page needs it. Trigger functions are left alone (Postgres refuses to call them outside a trigger).
--
-- Rollback: re-run the media_select_visible block from 20261025000012_chat_calls_voice.sql, and grant execute on the 13 helpers
-- back to anon.

drop policy if exists media_select_visible on storage.objects;

create policy media_select_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'media' and (
      (storage.foldername(objects.name))[1] = auth.uid()::text
      or exists (select 1 from public.posts p where p.media_path = objects.name or p.music_path = objects.name)
      or exists (select 1 from public.post_media pm where pm.path = objects.name)
      or exists (select 1 from public.comments c where c.audio_path = objects.name)
      or exists (select 1 from public.profiles pr where pr.avatar_path = objects.name or pr.cover_path = objects.name)
      or exists (select 1 from public.events e where e.cover_path = objects.name)
      or exists (select 1 from public.event_lineup l where l.image_path = objects.name)
      or exists (select 1 from public.communities c where c.cover_path = objects.name)
      or exists (select 1 from public.memories m where m.media_path = objects.name)
      or exists (select 1 from public.memory_replies r where r.audio_path = objects.name)
      or exists (select 1 from public.messages m where m.media_path = objects.name or m.audio_path = objects.name)
    )
  );

do $$
declare f text;
begin
  foreach f in array array[
    'public.are_friends(uuid, uuid)', 'public.is_blocked(uuid, uuid)', 'public.can_moderate_community(uuid)',
    'public.can_view_event(public.events)', 'public.can_view_memory(public.memories)', 'public.can_view_post(public.posts)',
    'public.community_is_public(uuid)', 'public.community_role(uuid)', 'public.has_feature(text, uuid)',
    'public.is_community_member(uuid)', 'public.is_conversation_member(uuid)', 'public.is_invited(uuid)', 'public.org_role(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
