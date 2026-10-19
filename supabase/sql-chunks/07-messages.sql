alter table public.messages enable row level security;

alter table public.notifications enable row level security;

alter table public.reports enable row level security;

alter table public.audit_log enable row level security;

-- profiles: readable by signed-in users unless blocked; self-service edits only.
drop policy if exists profiles_select on public.profiles;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or not public.is_blocked(auth.uid(), id));

drop policy if exists profiles_update on public.profiles;

create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- staff: no client access at all (no policies => denied). Managed with service role / SQL.

drop policy if exists blocks_select on public.blocks;

create policy blocks_select on public.blocks for select to authenticated using (blocker = auth.uid());

drop policy if exists blocks_insert on public.blocks;

create policy blocks_insert on public.blocks for insert to authenticated with check (blocker = auth.uid());

drop policy if exists blocks_delete on public.blocks;

create policy blocks_delete on public.blocks for delete to authenticated using (blocker = auth.uid());

drop policy if exists friendships_select on public.friendships;

create policy friendships_select on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists friendships_insert on public.friendships;

create policy friendships_insert on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not public.is_blocked(requester, addressee));

drop policy if exists friendships_accept on public.friendships;

create policy friendships_accept on public.friendships for update to authenticated
  using (addressee = auth.uid() and status = 'pending') with check (addressee = auth.uid() and status = 'accepted');

drop policy if exists friendships_delete on public.friendships;

create policy friendships_delete on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists communities_select on public.communities;

create policy communities_select on public.communities for select to authenticated using (true);

drop policy if exists communities_insert on public.communities;

create policy communities_insert on public.communities for insert to authenticated with check (created_by = auth.uid());
