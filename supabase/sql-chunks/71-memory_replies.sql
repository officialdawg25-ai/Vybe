create table if not exists public.memory_replies (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.memories(id) on delete cascade,
  author uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 500),
  audio_path text,
  audio_ms integer check (audio_ms is null or audio_ms between 500 and 61000),
  created_at timestamptz not null default now(),
  check (btrim(body) <> '' or audio_path is not null),
  check ((audio_path is null) = (audio_ms is null)),
  check (audio_path is null or audio_path like author::text || '/%')
);

create index if not exists memory_replies_memory_idx on public.memory_replies (memory_id, created_at);

alter table public.memory_replies enable row level security;

drop policy if exists memory_replies_read on public.memory_replies;

create policy memory_replies_read on public.memory_replies for select to authenticated
  using (author = auth.uid() or exists (select 1 from public.memories m where m.id = memory_id and m.author = auth.uid()));

drop policy if exists memory_replies_ins on public.memory_replies;

create policy memory_replies_ins on public.memory_replies for insert to authenticated with check (author = auth.uid() and public.can_reply_memory(memory_id));

drop policy if exists memory_replies_del on public.memory_replies;

create policy memory_replies_del on public.memory_replies for delete to authenticated using (author = auth.uid());

revoke all on public.memory_replies from anon, authenticated;

grant select, delete on public.memory_replies to authenticated;

grant insert (memory_id, author, body, audio_path, audio_ms) on public.memory_replies to authenticated;

create or replace function public.trg_memory_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.memory_replies where author = new.author and created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'Slow down a little.'; end if;
  perform public.notify((select author from public.memories where id = new.memory_id), 'memory_reply', new.author, 'memory', new.memory_id, 'rp:' || new.id);
  return new;
end $$;

drop trigger if exists memory_reply_guard on public.memory_replies;

create trigger memory_reply_guard before insert on public.memory_replies for each row execute function public.trg_memory_reply();
