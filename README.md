# VYBE — Life is better together.

Discover what moves you. Find your people. Make it happen.

A social experience platform: discovery feed, friends, plans (events + RSVPs), communities, messaging and notifications.

## Stack

| Concern | Choice |
| --- | --- |
| UI | React 18 + TypeScript + Vite, React Router (route-level code splitting), Lucide icons, Inter |
| Backend | Supabase: Postgres + Row Level Security, Auth, Realtime, Storage |
| Hosting | Cloudflare Workers static assets (`wrangler.jsonc`, SPA fallback) |

There is no custom API server: the browser talks to Supabase with the **anon** key, and **Row Level Security is the
security boundary**. Route guards in the UI are UX only.

## Setup

```bash
npm install
cp .env.example .env     # add VITE_SUPABASE_ANON_KEY (public anon key; never the service-role key)
npm run dev
```

Without those variables the app builds and renders, and shows a "not connected" notice instead of making requests.

### Database

Apply `supabase/migrations/*.sql` in order (SQL editor or `supabase db push`). They are additive (no drops), but
**back up first and review before running against a database that already holds data**: this repository was empty
when they were written and the existing project's schema could not be inspected.

Then in Supabase Auth settings:

- Set Site URL to your production origin and add `<origin>/signin` and `<origin>/reset` to Redirect URLs.
  Confirmation and reset emails use `window.location.origin`, so they follow whichever origin served the page.
- Grant staff (moderation) access only via SQL:
  `insert into public.staff (user_id, role) values ('<uuid>', 'moderator');`
  Clients cannot read or write `staff`.

### Deploy

```bash
npm run deploy    # build + wrangler deploy -> existing "vybe" Worker (requires CLOUDFLARE_API_TOKEN)
```

## Architecture

- **One social graph**: `friendships` (pending → accepted); blocks in `blocks`. Visibility helpers
  (`can_view_post`, `can_view_event`, `are_friends`, `is_blocked`, `community_role`) are `SECURITY DEFINER` with an
  empty `search_path`, and are the only place visibility rules live.
- **Posts**: `public | friends | community`; cursor pagination on `created_at`; counts via aggregate embeds (no stored counters).
- **Plans**: UTC instant + IANA zone; capacity enforced in a trigger with a row lock; invite-only plans are invisible until invited.
  Prices and ticket links are informational. **VYBE does not process payments.**
- **Communities**: public/private; roles owner/admin/moderator/member; join requests. Private community content is member-only
  (name and description are listed so people can request to join).
- **Messaging**: conversations are created only through the `start_dm` / `start_group` RPCs (block and DM-policy checks);
  idempotent sends via `client_id`; Realtime plus refetch on reconnect. Not end-to-end encrypted.
- **Notifications**: written only by triggers, deduplicated by `(user_id, dedupe_key)`; clients may only set `read_at`.
- **Media**: private `media` bucket; objects are readable only by their owner or when a visible post/profile/event/community
  references the path; MIME and size limits enforced by the bucket; signed URLs in the client.
- **Safety**: reports (`submitted → reviewing → actioned/dismissed/escalated`), staff-only review with an automatic audit log,
  insert throttles on posts/comments/messages, account-deletion RPC, data export.
- **i18n-ready**: message catalogue in `src/lib/i18n.ts`, `Intl` formatting for dates, money and time zones.

## Tests

```bash
npm run typecheck
npm test          # unit tests + RLS tests (embedded Postgres via PGlite, multiple identities)
npm run build
```

`tests/db/rls.test.ts` runs both migrations against PGlite with Supabase-style stubs (`auth.uid()`, roles, storage)
and checks allowed and forbidden operations across three users and a staff user. It validates the policies as written;
it is not a substitute for testing against a real Supabase project.

## Not implemented / not verified

Live streaming, billing and payments, organization accounts, typing indicators, push/email notifications, video
transcoding, an admin console UI, and end-to-end browser tests against a live backend.
