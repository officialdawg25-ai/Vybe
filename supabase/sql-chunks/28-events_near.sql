-- Events near a point (bounding box first, exact great-circle distance second). SECURITY INVOKER: RLS still decides
-- what each viewer may see, so private and invite-only events never leak through discovery.
create or replace function public.events_near(p_lat double precision, p_lng double precision, p_radius_km double precision default 50,
                                              p_from timestamptz default now(), p_to timestamptz default null, p_q text default null)
returns setof public.events
language sql stable security invoker set search_path = '' as $$
  select e.* from public.events e
  where e.status = 'active' and e.visibility = 'public' and e.lat is not null and e.lng is not null
    and coalesce(e.ends_at, e.starts_at + interval '4 hours') >= p_from
    and (p_to is null or e.starts_at <= p_to)
    and e.lat between p_lat - (least(p_radius_km, 500) / 111.0) and p_lat + (least(p_radius_km, 500) / 111.0)
    and e.lng between p_lng - (least(p_radius_km, 500) / (111.0 * greatest(0.05, cos(radians(p_lat)))))
                  and p_lng + (least(p_radius_km, 500) / (111.0 * greatest(0.05, cos(radians(p_lat)))))
    and 6371 * 2 * asin(least(1, sqrt(power(sin(radians(e.lat - p_lat) / 2), 2)
          + cos(radians(p_lat)) * cos(radians(e.lat)) * power(sin(radians(e.lng - p_lng) / 2), 2)))) <= least(p_radius_km, 500)
    and (p_q is null or p_q = '' or e.title ilike '%' || replace(replace(p_q, '%', ''), '_', '') || '%')
  order by e.starts_at
  limit 80;
$$;

grant execute on function public.events_near(double precision, double precision, double precision, timestamptz, timestamptz, text) to authenticated;

-- ------------------------------------------------------------ helpers
create or replace function public.can_manage_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = eid
    and (e.host = auth.uid() or (e.organization_id is not null and public.org_role(e.organization_id) in ('owner','admin','editor'))));
$$;

create or replace function public.can_view_event_id(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_view_event(e) from public.events e where e.id = eid), false);
$$;

revoke execute on function public.can_manage_event(uuid), public.can_view_event_id(uuid) from public, anon;

grant execute on function public.can_manage_event(uuid), public.can_view_event_id(uuid) to authenticated;

-- ------------------------------------------------------------ organization (page) posts
alter table public.posts add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists posts_org_idx on public.posts (organization_id, created_at desc) where organization_id is not null;

drop policy if exists posts_insert on public.posts;

create policy posts_insert on public.posts for insert to authenticated
  with check (
    author = auth.uid()
    and (community_id is null or public.is_community_member(community_id))
    and (media_path is null or media_path like auth.uid()::text || '/%')
    and (organization_id is null or (public.org_role(organization_id) in ('owner','admin','editor') and visibility = 'public'))
  );

grant insert (organization_id) on public.posts to authenticated;
