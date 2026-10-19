-- Part B5/5: column-level grants (revokes default table access, grants back only what the app needs)
-- Column-level grants: clients cannot rewrite ownership, authorship or history.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.blocks, public.friendships, public.communities, public.community_members,
  public.events, public.event_rsvps, public.posts, public.comments, public.reactions, public.saves,
  public.conversations, public.conversation_members, public.messages, public.notifications,
  public.reports, public.audit_log to authenticated;
grant update (display_name, bio, avatar_path, location, interests, dm_policy, onboarded_at) on public.profiles to authenticated;
grant insert, delete on public.blocks to authenticated;
grant insert, delete on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;
grant insert, delete on public.communities to authenticated;
grant update (name, description, rules, cover_path, topics, visibility) on public.communities to authenticated;
grant insert, delete on public.community_members to authenticated;
grant update (role, status) on public.community_members to authenticated;
grant insert, delete on public.events to authenticated;
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
