create policy memory_views_ins on public.memory_views for insert to authenticated with check (viewer = auth.uid() and public.can_view_memory_id(memory_id));

revoke all on public.memory_views from anon, authenticated;

grant select, insert on public.memory_views to authenticated;

create table if not exists public.memory_reactions (
  memory_id uuid not null references public.memories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('heart', 'like', 'laugh', 'wow', 'sad', 'fire')),
  created_at timestamptz not null default now(),
  primary key (memory_id, user_id)
);

alter table public.memory_reactions enable row level security;

drop policy if exists memory_reactions_read on public.memory_reactions;

create policy memory_reactions_read on public.memory_reactions for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));

drop policy if exists memory_reactions_ins on public.memory_reactions;

create policy memory_reactions_ins on public.memory_reactions for insert to authenticated with check (user_id = auth.uid() and public.can_view_memory_id(memory_id));

drop policy if exists memory_reactions_upd on public.memory_reactions;

create policy memory_reactions_upd on public.memory_reactions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists memory_reactions_del on public.memory_reactions;

create policy memory_reactions_del on public.memory_reactions for delete to authenticated using (user_id = auth.uid());

revoke all on public.memory_reactions from anon, authenticated;

grant select, insert, delete on public.memory_reactions to authenticated;

grant update (emoji) on public.memory_reactions to authenticated;

create or replace function public.trg_memory_reaction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify((select author from public.memories where id = new.memory_id), 'memory_reaction', new.user_id, 'memory', new.memory_id, 'mr:' || new.memory_id || ':' || new.user_id);
  return new;
end $$;

drop trigger if exists memory_reaction_notify on public.memory_reactions;

create trigger memory_reaction_notify after insert on public.memory_reactions for each row execute function public.trg_memory_reaction();
