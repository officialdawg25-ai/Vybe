create or replace function public.limit_display_name_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.display_name is not distinct from old.display_name then
    new.display_name_changed_at := old.display_name_changed_at;
    return new;
  end if;
  if old.onboarded_at is null then
    return new;
  end if;
  if old.display_name_changed_at is not null and old.display_name_changed_at > now() - interval '14 days' then
    raise exception 'You can change your name again on %.', to_char(old.display_name_changed_at + interval '14 days', 'FMDD Mon YYYY')
      using errcode = 'check_violation', hint = 'name_cooldown';
  end if;
  new.display_name_changed_at := now();
  return new;
end $$;

revoke all on function public.limit_display_name_change() from public, anon, authenticated;

drop trigger if exists trg_limit_display_name on public.profiles;

create trigger trg_limit_display_name before update of display_name, display_name_changed_at on public.profiles
  for each row execute function public.limit_display_name_change();
