grant update (title, description, cover_path, starts_at, ends_at, timezone, location, visibility, capacity,
  price_cents, currency, ticket_url, status) on public.events to authenticated;

grant insert, delete on public.event_rsvps to authenticated;

grant update (status) on public.event_rsvps to authenticated;

grant insert, delete on public.posts to authenticated;

grant update (body, visibility) on public.posts to authenticated;

grant insert, delete on public.comments to authenticated;

grant update (body) on public.comments to authenticated;

grant insert, update (kind), delete on public.reactions to authenticated;

grant insert, delete on public.saves to authenticated;

grant update (last_read_at, muted), delete on public.conversation_members to authenticated;

grant insert on public.messages to authenticated;

grant update (body, deleted_at) on public.messages to authenticated;

grant update (read_at), delete on public.notifications to authenticated;

grant insert on public.reports to authenticated;

grant update (status) on public.reports to authenticated;

-- ----------------------------------------------------------- triggers
-- Profile creation on signup. Falls back to a generated username on collision.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  wanted text := lower(coalesce(new.raw_user_meta_data->>'username', ''));
  shown text := left(coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(coalesce(new.email, ''), '@', 1)), 60);
begin
  if wanted !~ '^[a-z0-9_]{3,30}$' then
    wanted := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  begin
    insert into public.profiles (id, username, display_name) values (new.id, wanted, shown);
  exception when unique_violation then
    insert into public.profiles (id, username, display_name)
    values (new.id, 'user_' || substr(replace(new.id::text, '-', ''), 1, 10), shown);
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
