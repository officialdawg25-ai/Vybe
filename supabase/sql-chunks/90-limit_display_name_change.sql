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

-- 16: one campaign engine for two placements (Home billboard, Discover hero), honest labels, and organisation submissions.
--
--  * promo_slides gains placements (home and/or discover), a kind (sponsored | house | announcement) so VYBE's own promotions
--    are never labelled as paid, and an owning organisation for campaigns that organisations submit.
--  * State machine, enforced in the database (a client cannot make a campaign live by editing a field):
--      organisation owner/admin:  draft ⇄ submitted   (may edit, resubmit after a rejection, or delete their own until approved)
--      platform admin:            submitted → live (approved; "scheduled" while before starts_at) | rejected (with a reason)
--                                 live ⇄ paused, and anything else on platform-owned rows
--    Organisation rows are always "Sponsored", carry the organisation's own name as the advertiser, and their priority is set
--    by the admin who approves them. Reviews are written to audit_log and notify the organisation's owners and admins.
--  * Organisations upload creatives to brand/promo/o-<organisation id>/…; platform media stays under brand/promo/.
-- Additive: existing slides keep working (placements default to Home only, kind defaults to sponsored, no owner).
-- Rollback: drop the trigger/functions/policies below, then the added columns; restore the two original check constraints.

alter table public.promo_slides add column if not exists placements text[] not null default '{home}';

alter table public.promo_slides add column if not exists kind text not null default 'sponsored';

alter table public.promo_slides add column if not exists organization_id uuid references public.organizations(id) on delete cascade;

alter table public.promo_slides add column if not exists review_note text;

alter table public.promo_slides add column if not exists submitted_at timestamptz;

alter table public.promo_slides add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;

alter table public.promo_slides add column if not exists reviewed_at timestamptz;

alter table public.promo_slides drop constraint if exists promo_slides_placements_check;

alter table public.promo_slides add constraint promo_slides_placements_check
  check (cardinality(placements) between 1 and 2 and placements <@ array['home','discover']::text[]);
