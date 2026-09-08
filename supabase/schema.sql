-- ============================================================================
-- NexSecurity — Database Schema + Row-Level Security
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
--
-- Design principle: every table that holds protected content is locked
-- down by default (RLS enabled, no policies = no access) and only opened
-- up by narrow, explicit policies. The app's ANON key + a user's session
-- is never enough on its own — Postgres itself checks the allowlist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. authorized_users — the allowlist. auth.users (managed by Supabase Auth)
--    is where Google identities land after OAuth; a row here is what turns
--    an authenticated identity into an authorized one.
-- ---------------------------------------------------------------------------
create table if not exists public.authorized_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  role text not null default 'USER' check (role in ('USER', 'ADMIN')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  -- When true, this account may only sign in from an IP + device combo
  -- that an admin has explicitly approved in user_devices. Default false
  -- so adding this never locks anyone out until an admin opts an account in.
  restrict_devices boolean not null default false,
  -- Free trial: 'paid' accounts follow the normal flow untouched. A
  -- 'trial' account gets trial_duration_minutes set by the admin at
  -- creation time; trial_started_at/trial_expires_at stay null until the
  -- account's first-ever login (see lib/auth.ts), then get stamped
  -- together so the clock starts from actual first use, not from
  -- whenever the admin happened to create the row.
  account_type text not null default 'paid' check (account_type in ('paid', 'trial')),
  trial_duration_minutes integer,
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_authorized_users_email on public.authorized_users (lower(email));

-- ---------------------------------------------------------------------------
-- 2. boards — hierarchical nodes. parent_id null = top-level ("Learn").
--    A board with a video is a "leaf" board.
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.boards (id) on delete cascade,
  title text not null,
  description text,
  thumbnail_url text,
  sort_order integer not null default 0,
  published boolean not null default false,
  -- 'routine' boards skip the board/video hierarchy entirely and just
  -- display routine_image_url (a class routine / timetable graphic).
  board_type text not null default 'normal' check (board_type in ('normal', 'routine')),
  routine_image_url text,
  -- 'universal' = visible to every authorized user (default, unchanged
  -- behavior). 'restricted' = visible only to users explicitly granted
  -- access via board_user_access below — and the restriction cascades to
  -- everything nested under this board, see lib/boardAccess.ts.
  visibility text not null default 'universal' check (visibility in ('universal', 'restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_boards_parent on public.boards (parent_id);

-- ---------------------------------------------------------------------------
-- 2b. board_user_access — explicit per-user grants for 'restricted' boards.
-- ---------------------------------------------------------------------------
create table if not exists public.board_user_access (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  user_email text not null,
  created_at timestamptz not null default now(),
  unique (board_id, user_email)
);

create index if not exists idx_board_user_access_board on public.board_user_access (board_id);
create index if not exists idx_board_user_access_user on public.board_user_access (lower(user_email));

-- ---------------------------------------------------------------------------
-- 3. pages — an optional intermediate container a board can point to
--    (per the brief's nested Board -> Page -> Board structure).
-- ---------------------------------------------------------------------------
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  thumbnail_url text,
  sort_order integer not null default 0,
  layout text not null default 'grid' check (layout in ('grid', 'list')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- a board's "destination" can be another board OR a page
alter table public.boards
  add column if not exists destination_page_id uuid references public.pages (id) on delete set null;

-- pages contain boards (many-to-many with explicit ordering)
create table if not exists public.page_boards (
  page_id uuid not null references public.pages (id) on delete cascade,
  board_id uuid not null references public.boards (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (page_id, board_id)
);

-- ---------------------------------------------------------------------------
-- 4. videos — 1:1 with a leaf board. The raw URL/provider asset id NEVER
--    goes in an API response to a normal user — only the /api/video/:id/play
--    route (server-side) reads this table and returns a short-lived token.
-- ---------------------------------------------------------------------------
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  -- No longer unique: a board (chapter) can hold multiple classes
  -- ("Part 1", "Part 2", ...), ordered by sort_order below.
  board_id uuid not null references public.boards (id) on delete cascade,
  title text not null,
  description text,
  thumbnail_url text,
  -- 'bunny' (paid, protected — signed short-lived embed token) or
  -- 'youtube' (free, unlisted — see app/api/video/[id]/play/route.ts for
  -- what each provider means for source_ref's shape and for the level of
  -- protection actually achievable).
  provider text not null default 'bunny',
  -- "{libraryId}/{videoGuid}" from the Bunny embed URL — never exposed
  -- to the client; only used server-side to build a signed embed token.
  -- For provider='m3u8' this holds the .m3u8 playlist URL instead.
  source_ref text not null,
  -- provider='m3u8' only: the Referer value the source CDN requires.
  -- Never exposed to the client — see supabase/migrations/0008 and
  -- app/api/video/[id]/hls-proxy/route.ts.
  referer_header text,
  -- Ordering when a board has multiple parts (Part 1, Part 2, ...).
  sort_order integer not null default 0,
  -- A single dedicated download link for this class specifically —
  -- distinct from the many-per-class links in video_resources below.
  download_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_videos_board_sort on public.videos (board_id, sort_order);

-- ---------------------------------------------------------------------------
-- 5. audit_logs — append-only security/admin event trail.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  event_type text not null,
  actor_email text,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_created on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- 6. video_playback_tokens — short-lived, single-purpose tokens issued
--    after a server-side authorization check. Used to rate-limit and
--    to make token issuance auditable/revocable.
-- ---------------------------------------------------------------------------
create table if not exists public.video_playback_tokens (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  user_email text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_playback_tokens_user_video on public.video_playback_tokens (user_email, video_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. video_resources — supplementary links attached to a class (lecture
--    sheet, exam, notes, etc). Generic title+URL rather than a fixed
--    "kind" enum, so admins aren't boxed into predefined categories.
--    Same access model as `videos`: no SELECT policy for regular users —
--    only reachable via the admin client, after the video page's normal
--    auth + board-published check has already passed (see
--    app/learn/video/[id]/page.tsx).
-- ---------------------------------------------------------------------------
create table if not exists public.video_resources (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  title text not null,
  url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_resources_video on public.video_resources (video_id, sort_order);

-- ---------------------------------------------------------------------------
-- 8. e_books — downloadable books attached to a board (chapter/subject),
--    shown as their own section on that board's page. price is almost
--    always 0 ("Free"); kept numeric rather than boolean in case a paid
--    e-book is ever added. Same access model as video_resources: no
--    regular-user SELECT policy — reached via the admin client only,
--    after the board page's normal auth + published check already
--    passed (see app/learn/board/[id]/page.tsx).
-- ---------------------------------------------------------------------------
create table if not exists public.e_books (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id) on delete cascade,
  title text not null,
  description text,
  thumbnail_url text,
  download_url text,
  format text not null default 'PDF',
  price numeric(10, 2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_e_books_board_sort on public.e_books (board_id, sort_order);

-- ---------------------------------------------------------------------------
-- 9. user_devices — one row per (user, device) for accounts with
--    restrict_devices = true on authorized_users. "Device" here means
--    device_id: a random id middleware.ts plants in a long-lived cookie
--    the first time a browser is ever seen (see lib/deviceId.ts), NOT an
--    IP address — IP changes constantly (wifi <-> mobile data) and is
--    kept only as history (ip_history) for an admin reviewing activity,
--    never used to decide identity. A brand-new device_id creates its own
--    row here with status 'pending' the first time its user signs in; an
--    admin decision (Approve/Reject/Block) is what changes that status.
-- ---------------------------------------------------------------------------
create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.authorized_users (id) on delete cascade,
  device_id uuid not null,
  -- Most recent IP seen for this device — convenience display column;
  -- ip_history below is the actual record used for review.
  ip_address text not null,
  -- Append-only, capped history of {ip, at} the device has been seen
  -- from. Never consulted for the auth decision itself (device_id is),
  -- only shown to an admin as secondary security context.
  ip_history jsonb not null default '[]'::jsonb,
  device_label text not null default 'Unknown device',
  -- pending    = seen, not yet decided by an admin (a "New Device Request")
  -- authorized = admin-approved; can sign in normally
  -- restricted = admin-rejected ("Rejected" in the admin UI); can be
  --              reconsidered later
  -- blocked    = admin's stronger, deliberate "never let this device in"
  status text not null default 'pending' check (status in ('pending', 'authorized', 'restricted', 'blocked')),
  -- Admin-given friendly name, e.g. "Home WiFi laptop" — pure label,
  -- plays no role in the auth check itself.
  label text,
  note text,
  -- Who/what approved (or rejected/blocked) this device's CURRENT status:
  -- an admin's email when a person made the call, or null when the
  -- system auto-approved it (a brand-new account's first device — see
  -- lib/auth.ts). Lets the admin panel show "Approved by admin@x.com" or
  -- "First device — auto-approved" directly on the row.
  approved_by text,
  approved_at timestamptz,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, device_id)
);

create index if not exists idx_user_devices_user on public.user_devices (user_id);
create index if not exists idx_user_devices_user_status on public.user_devices (user_id, status);
create index if not exists idx_user_devices_device_id on public.user_devices (device_id);
create index if not exists idx_user_devices_last_seen on public.user_devices (user_id, last_seen desc);

-- ---------------------------------------------------------------------------
-- 10. video_progress — "resume playback". One row per (user, video)
--     holding the last watched position, updated periodically by
--     VideoPlayer.tsx while a class is playing, and read back by
--     /api/video/[id]/play so reopening a class auto-seeks to where the
--     student left off. Works for both providers (bunny + youtube).
-- ---------------------------------------------------------------------------
create table if not exists public.video_progress (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  video_id uuid not null references public.videos (id) on delete cascade,
  position_seconds integer not null default 0,
  duration_seconds integer,
  updated_at timestamptz not null default now(),
  unique (user_email, video_id)
);

create index if not exists idx_video_progress_user_video on public.video_progress (lower(user_email), video_id);

-- ---------------------------------------------------------------------------
-- 11. site_popup_settings — a single site-wide announcement popup, shown
--     to authorized users on a repeating interval. Singleton row (id
--     pinned to 1) — one configuration for the whole site, not a list of
--     campaigns. `version` is bumped by the API on every save so an
--     updated announcement reaches everyone immediately instead of
--     waiting out the old interval (see user_popup_views below).
-- ---------------------------------------------------------------------------
create table if not exists public.site_popup_settings (
  id integer primary key default 1,
  enabled boolean not null default false,
  title text not null default '',
  message text not null default '',
  button_label text not null default 'Got it',
  button_url text,
  -- Hours between repeat showings to the same user ("watch time").
  interval_hours integer not null default 24 check (interval_hours > 0),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint site_popup_settings_singleton check (id = 1)
);

insert into public.site_popup_settings (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 12. user_popup_views — one row per user: the last popup version they
--     were shown, and when. A version_seen that doesn't match the
--     CURRENT site_popup_settings.version counts as "hasn't seen this
--     one yet", regardless of last_shown_at.
-- ---------------------------------------------------------------------------
create table if not exists public.user_popup_views (
  user_email text primary key,
  version_seen integer not null,
  last_shown_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 13. push_subscriptions — one row per browser/device granted
--     notification permission, tied to the account it was subscribed
--     under. `endpoint` (the push service URL the browser gave us) is
--     the natural unique key: different per browser/device/profile.
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions (lower(user_email));

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.authorized_users enable row level security;
alter table public.boards enable row level security;
alter table public.pages enable row level security;
alter table public.page_boards enable row level security;
alter table public.videos enable row level security;
alter table public.audit_logs enable row level security;
alter table public.video_playback_tokens enable row level security;
alter table public.video_resources enable row level security;
alter table public.e_books enable row level security;
alter table public.user_devices enable row level security;
alter table public.video_progress enable row level security;
alter table public.board_user_access enable row level security;
alter table public.site_popup_settings enable row level security;
alter table public.user_popup_views enable row level security;
alter table public.push_subscriptions enable row level security;

-- Helper: is the currently authenticated user an ACTIVE authorized user?
create or replace function public.is_authorized() returns boolean as $$
  select exists (
    select 1 from public.authorized_users au
    where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and au.status = 'ACTIVE'
  );
$$ language sql stable security definer set search_path = public;

-- Helper: is the currently authenticated user an ACTIVE ADMIN?
create or replace function public.is_admin() returns boolean as $$
  select exists (
    select 1 from public.authorized_users au
    where lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and au.status = 'ACTIVE'
      and au.role = 'ADMIN'
  );
$$ language sql stable security definer set search_path = public;

-- authorized_users: a user may read only their OWN row (to learn their own
-- role/status). All writes and reading the full list are ADMIN-only.
drop policy if exists au_select_self on public.authorized_users;
create policy au_select_self on public.authorized_users
  for select using (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

drop policy if exists au_admin_write on public.authorized_users;
create policy au_admin_write on public.authorized_users
  for all using (public.is_admin()) with check (public.is_admin());

-- boards: authorized (active) users can read PUBLISHED boards.
-- Admins can read/write everything, including unpublished.
drop policy if exists boards_select_authorized on public.boards;
create policy boards_select_authorized on public.boards
  for select using (
    (public.is_authorized() and published = true) or public.is_admin()
  );

drop policy if exists boards_admin_write on public.boards;
create policy boards_admin_write on public.boards
  for all using (public.is_admin()) with check (public.is_admin());

-- pages: same shape as boards. Pages are only exposed via a published
-- board's destination, but we still gate read access directly.
drop policy if exists pages_select_authorized on public.pages;
create policy pages_select_authorized on public.pages
  for select using (public.is_authorized() or public.is_admin());

drop policy if exists pages_admin_write on public.pages;
create policy pages_admin_write on public.pages
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists page_boards_select_authorized on public.page_boards;
create policy page_boards_select_authorized on public.page_boards
  for select using (public.is_authorized() or public.is_admin());

drop policy if exists page_boards_admin_write on public.page_boards;
create policy page_boards_admin_write on public.page_boards
  for all using (public.is_admin()) with check (public.is_admin());

-- videos: intentionally NO select policy for normal users. Only admins
-- can read the videos table directly. Regular playback goes exclusively
-- through the /api/video/:id/play route using the service-role key
-- server-side, after an explicit authorization check in application code.
-- This guarantees the raw source_ref can never leak via a direct
-- PostgREST query, no matter what the client sends.
drop policy if exists videos_admin_all on public.videos;
create policy videos_admin_all on public.videos
  for all using (public.is_admin()) with check (public.is_admin());

-- video_resources: same reasoning as videos — no regular-user SELECT
-- policy. The video page reaches these through the admin client only
-- after its own auth + board-published check already passed.
drop policy if exists video_resources_admin_all on public.video_resources;
create policy video_resources_admin_all on public.video_resources
  for all using (public.is_admin()) with check (public.is_admin());

-- e_books: same reasoning as video_resources — no regular-user SELECT
-- policy. The board page reaches these through the admin client only
-- after its own auth + board-published check already passed.
drop policy if exists e_books_admin_all on public.e_books;
create policy e_books_admin_all on public.e_books
  for all using (public.is_admin()) with check (public.is_admin());

-- user_devices: admin-only, same as e_books. Read and written from
-- lib/auth.ts via the service-role admin client (this is a
-- security-check code path, consistent with how video authorization
-- already works), and from the admin API routes for the management UI.
drop policy if exists user_devices_admin_all on public.user_devices;
create policy user_devices_admin_all on public.user_devices
  for all using (public.is_admin()) with check (public.is_admin());

-- audit_logs: admins can read; inserts happen via service-role from
-- trusted server code only (no client-facing insert policy).
drop policy if exists audit_logs_admin_select on public.audit_logs;
create policy audit_logs_admin_select on public.audit_logs
  for select using (public.is_admin());

-- video_playback_tokens: a user may see their own issued tokens only
-- (useful for admin auditing / self-service "why did playback fail").
drop policy if exists playback_tokens_self_select on public.video_playback_tokens;
create policy playback_tokens_self_select on public.video_playback_tokens
  for select using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

-- video_progress: a user may only read/write their OWN progress rows.
-- All access in practice goes through the service-role admin client from
-- app/api/video/[id]/play and app/api/video/[id]/progress (same pattern
-- as videos / video_playback_tokens above), but this policy is still the
-- real backstop if that ever changes.
drop policy if exists video_progress_self on public.video_progress;
create policy video_progress_self on public.video_progress
  for all using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  )
  with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

-- board_user_access: a user may see their OWN grants (needed so
-- lib/boardAccess.ts's checks work under the normal RLS-bound server
-- client). Admins can see and manage everything.
drop policy if exists board_user_access_self_select on public.board_user_access;
create policy board_user_access_self_select on public.board_user_access
  for select using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

drop policy if exists board_user_access_admin_write on public.board_user_access;
create policy board_user_access_admin_write on public.board_user_access
  for all using (public.is_admin())
  with check (public.is_admin());

-- site_popup_settings: any authorized user can read it (the popup API
-- needs to check enabled/interval); only admins can write.
drop policy if exists site_popup_settings_read on public.site_popup_settings;
create policy site_popup_settings_read on public.site_popup_settings
  for select using (public.is_authorized() or public.is_admin());

drop policy if exists site_popup_settings_admin_write on public.site_popup_settings;
create policy site_popup_settings_admin_write on public.site_popup_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- user_popup_views: a user may only read/write their OWN "last seen"
-- row — same shape as video_progress above.
drop policy if exists user_popup_views_self on public.user_popup_views;
create policy user_popup_views_self on public.user_popup_views
  for all using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  )
  with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

-- push_subscriptions: same self-access shape as video_progress /
-- user_popup_views above.
drop policy if exists push_subscriptions_self on public.push_subscriptions;
create policy push_subscriptions_self on public.push_subscriptions
  for all using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  )
  with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

-- ============================================================================
-- Seed: replace with your own admin email after first deploy, e.g.:
-- insert into public.authorized_users (email, role, status)
--   values ('you@example.com', 'ADMIN', 'ACTIVE');
-- ============================================================================
