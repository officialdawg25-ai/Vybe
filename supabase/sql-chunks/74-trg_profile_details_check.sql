-- Validates the free-form parts so nothing unsafe or oversized is stored (links must be https, visibility values fixed).
create or replace function public.trg_profile_details_check() returns trigger
language plpgsql set search_path = '' as $$
declare e jsonb; k text; v text;
begin
  for e in select * from jsonb_array_elements(new.links) loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'url', '') !~* '^https://[^\s]{3,255}$' or char_length(coalesce(e ->> 'label', '')) > 40 then raise exception 'Links must start with https://'; end if;
  end loop;
  for e in select * from jsonb_array_elements(new.education) loop
    if jsonb_typeof(e) <> 'object' or char_length(coalesce(e ->> 'school', '')) not between 1 and 120 or char_length(coalesce(e ->> 'field', '')) > 120 then raise exception 'Check your education entries'; end if;
  end loop;
  for e in select * from jsonb_array_elements(new.work) loop
    if jsonb_typeof(e) <> 'object' or char_length(coalesce(e ->> 'employer', '')) not between 1 and 120 or char_length(coalesce(e ->> 'role', '')) > 120 then raise exception 'Check your work entries'; end if;
  end loop;
  if (select count(*) from jsonb_object_keys(new.contact)) > 6 then raise exception 'Too many contact fields'; end if;
  for k, v in select key, value from jsonb_each_text(new.contact) loop
    if char_length(v) > 120 then raise exception 'Contact details are too long'; end if;
  end loop;
  for k, v in select key, value from jsonb_each_text(new.visibility) loop
    if v not in ('public', 'friends', 'me') or k not in ('about', 'personal', 'work', 'education', 'hobbies', 'travel', 'links', 'contact') then raise exception 'Invalid visibility'; end if;
  end loop;
  if exists (select 1 from unnest(new.hobbies || new.travel || new.languages) x where char_length(x) not between 1 and 40) then raise exception 'Entries must be 1 to 40 characters'; end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profile_details_check on public.profile_details;

create trigger profile_details_check before insert or update on public.profile_details for each row execute function public.trg_profile_details_check();
