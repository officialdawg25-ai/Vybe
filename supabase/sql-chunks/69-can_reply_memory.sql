-- Replies behave like messages: they respect the owner's "who can message me" setting.
create or replace function public.can_reply_memory(mid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.can_view_memory(m) and m.author <> auth.uid() and m.expires_at > now()
                          and (p.dm_policy = 'everyone' or public.are_friends(auth.uid(), m.author))
                   from public.memories m join public.profiles p on p.id = m.author where m.id = mid), false);
$$;

drop policy if exists memories_read on public.memories;

create policy memories_read on public.memories for select to authenticated using (public.can_view_memory(memories));

drop policy if exists memories_ins on public.memories;

create policy memories_ins on public.memories for insert to authenticated with check (author = auth.uid());

drop policy if exists memories_upd on public.memories;

create policy memories_upd on public.memories for update to authenticated using (author = auth.uid()) with check (author = auth.uid());

drop policy if exists memories_del on public.memories;

create policy memories_del on public.memories for delete to authenticated using (author = auth.uid());

revoke all on public.memories from anon, authenticated;

grant select, delete on public.memories to authenticated;

grant insert (author, kind, media_path, text_body, bg, visibility) on public.memories to authenticated;

grant update (visibility, highlight, highlight_title) on public.memories to authenticated;

create or replace function public.trg_memory_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.memories where author = new.author and created_at > now() - interval '24 hours';
  if n >= 40 then raise exception 'You have shared a lot of memories today. Try again tomorrow.'; end if;
  return new;
end $$;

drop trigger if exists memory_limit on public.memories;

create trigger memory_limit before insert on public.memories for each row execute function public.trg_memory_limit();

create table if not exists public.memory_views (
  memory_id uuid not null references public.memories(id) on delete cascade,
  viewer uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (memory_id, viewer)
);

alter table public.memory_views enable row level security;

drop policy if exists memory_views_read on public.memory_views;

create policy memory_views_read on public.memory_views for select to authenticated
  using (viewer = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));

drop policy if exists memory_views_ins on public.memory_views;
