revoke execute on function public.start_call(uuid, text, boolean) from public, anon;

grant execute on function public.start_call(uuid, text, boolean) to authenticated;

-- Migration 14. Additive and re-runnable; no data is rewritten.
--
-- 1. Media read policy: in the lineup and community sub-queries the unqualified `name` bound to event_lineup.name and
--    communities.name (both tables have a `name` column), so `l.image_path = name` compared the image path with the act's own
--    name and never matched. Lineup images and community covers were therefore unreadable to everyone except their uploader.
--    Every reference is now qualified as objects.name. Nothing else changes: each sub-query still runs under the reader's RLS,
--    so a file is readable only when a row the reader may see points at it.
--
-- 2. Promo placements: the same admin-managed slides can now target the Home billboard or the Discover hero, and say what they
--    are (a paid sponsorship, a VYBE house promotion, or a platform announcement) so the label shown is truthful.
--    Existing slides keep their behaviour (placement 'home', label 'sponsored').
--
-- 3. Signed-out callers could run the visibility helpers over /rest/v1/rpc (the Supabase advisor flags 32 SECURITY DEFINER
--    functions executable by anon). Most only consult auth.uid() and return nothing useful to anon, but are_friends(a, b) and
--    is_blocked(a, b) answered for ANY two member ids. Anon has no table grants and no policy anon can reach calls these helpers,
--    so EXECUTE is moved from PUBLIC/anon to authenticated (and service_role). get_auth_hero() stays public: the signed-out
--    sign-in page needs it. Trigger functions are left alone (Postgres refuses to call them outside a trigger).
--
-- Rollback: re-run the media_select_visible block from 20261025000012_chat_calls_voice.sql; the two promo columns can stay
-- (they default to the old behaviour) or be dropped with `alter table public.promo_slides drop column placement, drop column label`.

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

alter table public.promo_slides add column if not exists placement text not null default 'home';

alter table public.promo_slides add column if not exists label text not null default 'sponsored';

alter table public.promo_slides drop constraint if exists promo_slides_placement_check;

alter table public.promo_slides add constraint promo_slides_placement_check check (placement in ('home', 'discover'));

alter table public.promo_slides drop constraint if exists promo_slides_label_check;

alter table public.promo_slides add constraint promo_slides_label_check check (label in ('sponsored', 'house', 'announcement'));

create index if not exists promo_slides_placement_idx on public.promo_slides (placement, status, starts_at);

-- Writes stay admin-only through the existing RLS policies; these are just the column grants for the new fields.
grant insert (placement, label), update (placement, label) on public.promo_slides to authenticated;
