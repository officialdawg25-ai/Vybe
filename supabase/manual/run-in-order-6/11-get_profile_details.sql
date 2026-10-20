-- The only way anyone else reads details: sections come back only if their visibility allows this viewer.
-- p_as lets the OWNER preview their profile as 'public' or as a 'friend' ("View as").
create or replace function public.get_profile_details(p_user uuid, p_as text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); d public.profile_details; lvl integer; bd date; r jsonb := '{}'::jsonb;
  sect text; allowed boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me <> p_user and public.is_blocked(me, p_user) then return null; end if;
  -- viewer level: 3 = me, 2 = friend, 1 = anyone
  lvl := case when me = p_user then 3 when public.are_friends(me, p_user) then 2 else 1 end;
  if me = p_user and p_as = 'public' then lvl := 1; elsif me = p_user and p_as = 'friend' then lvl := 2; end if;
  select * into d from public.profile_details where user_id = p_user;
  if not found then return jsonb_build_object('level', lvl); end if;
  select birth_date into bd from public.profile_private where user_id = p_user;
  r := jsonb_build_object('level', lvl);
  foreach sect in array array['about', 'personal', 'work', 'education', 'hobbies', 'travel', 'links', 'contact'] loop
    allowed := lvl = 3 and p_as is null
      or (d.visibility ->> sect) = 'public'
      or ((d.visibility ->> sect) = 'friends' and lvl >= 2);
    if not allowed then continue; end if;
    r := r || case sect
      when 'about' then jsonb_build_object('about', d.about)
      when 'personal' then jsonb_build_object('personal', jsonb_build_object('current_city', d.current_city, 'hometown', d.hometown, 'relationship', d.relationship,
                             'gender', case when lvl = 3 and p_as is null then d.gender end, 'languages', to_jsonb(d.languages),
                             'birthday', case when d.birthday_visible and bd is not null then to_char(bd, 'FMDD FMMonth') end))
      when 'work' then jsonb_build_object('work', d.work)
      when 'education' then jsonb_build_object('education', d.education)
      when 'hobbies' then jsonb_build_object('hobbies', to_jsonb(d.hobbies))
      when 'travel' then jsonb_build_object('travel', to_jsonb(d.travel))
      when 'links' then jsonb_build_object('links', d.links)
      else jsonb_build_object('contact', d.contact)
    end;
  end loop;
  return r;
end $$;

-- Counts for the profile header. Followers/following obey the owner's setting; friends is always shown to people who can see the profile.
create or replace function public.profile_stats(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); pol text; show_f boolean;
begin
  if me is null then raise exception 'Sign in' using errcode = '28000'; end if;
  if me <> p_user and public.is_blocked(me, p_user) then return null; end if;
  select show_followers into pol from public.profiles where id = p_user;
  show_f := me = p_user or pol = 'public' or (pol = 'friends' and public.are_friends(me, p_user));
  return jsonb_build_object(
    'friends', (select count(*) from public.friendships where status = 'accepted' and (requester = p_user or addressee = p_user)),
    'followers', case when show_f then (select count(*) from public.follows where target_type = 'profile' and target_id = p_user) end,
    'following', case when show_f then (select count(*) from public.follows where follower = p_user) end,
    'i_follow', exists (select 1 from public.follows where follower = me and target_type = 'profile' and target_id = p_user));
end $$;
