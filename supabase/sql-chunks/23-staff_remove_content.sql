create or replace function public.staff_remove_content(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.reports;
begin
  if not public.is_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.reports where id = rid;
  if not found then raise exception 'report not found'; end if;
  case r.entity_type
    when 'post' then delete from public.posts where id = r.entity_id;
    when 'comment' then delete from public.comments where id = r.entity_id;
    when 'event' then update public.events set status = 'cancelled' where id = r.entity_id;
    when 'community' then delete from public.communities where id = r.entity_id;
    when 'stream' then update public.live_streams set status = 'cancelled' where id = r.entity_id and status = 'scheduled';
    when 'message' then update public.messages set body = 'Message removed', deleted_at = now() where id = r.entity_id;
    else raise exception 'this content type cannot be removed from here';
  end case;
  update public.reports set status = 'actioned' where id = rid;
  insert into public.audit_log (actor, action, entity_type, entity_id, detail)
  values (auth.uid(), 'content.removed', r.entity_type, r.entity_id, jsonb_build_object('report', rid));
end $$;

revoke execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) from public, anon;

grant execute on function public.staff_report_context(uuid), public.staff_remove_content(uuid) to authenticated;

-- Brand & Experience: administrator-managed authentication hero (image or video).
--
-- * One settings row ('auth_hero') holds a private `draft` and the public `published` copy.
-- * Admins write only through the RPCs below (no table write grants). Anyone, including
--   signed-out visitors, can read the *published* copy through get_auth_hero().
-- * Uploads go to the private `brand-draft` bucket; publishing copies them into the public
--   `brand` bucket, and publish refuses unless every referenced file is already there, so a
--   failed copy can never replace the last valid hero.
-- Admin = a row in public.staff with role 'admin' (moderators are not admins).

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'admin');
$$;

create table if not exists public.site_settings (
  key text primary key check (key in ('auth_hero')),
  draft jsonb,
  published jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz
);

alter table public.site_settings enable row level security;

drop policy if exists site_settings_admin_select on public.site_settings;

create policy site_settings_admin_select on public.site_settings for select to authenticated using (public.is_admin());

revoke all on public.site_settings from anon, authenticated;

grant select on public.site_settings to authenticated;
