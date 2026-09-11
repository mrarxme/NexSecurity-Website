-- An in-app notification inbox, separate from push_subscriptions
-- (0008). Push delivery only reaches a device that both supports the
-- Push API AND has an active subscription — iOS Safari outside an
-- installed, standalone PWA doesn't support it at all, and any device
-- can have permission denied/revoked. This table is what makes "a new
-- class/ebook/routine went up" visible inside the app itself (the bell
-- icon in TopNav.tsx) regardless of whether push ever reached that
-- device — push and this inbox are two independent delivery paths for
-- the exact same event, not one built on top of the other.
--
-- One row per (recipient, event) — same shape as push_subscriptions
-- being one row per (user, device) rather than a shared row with a
-- join table; simpler to query "my unread notifications" as a single
-- indexed lookup with no join.
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  type text not null check (type in ('class', 'ebook', 'routine')),
  title text not null,
  body text not null,
  -- Where clicking the notification navigates to — always an
  -- in-app path (e.g. /learn/video/<id>), never an external URL.
  url text not null,
  -- null = unread. Set once, when the user opens/clicks it (see
  -- app/api/notifications/[id]/read) — "unread" is the only list this
  -- table is ever queried for (see app/api/notifications/route.ts), so
  -- read notifications intentionally just stop showing up rather than
  -- needing a separate archived/hidden flag.
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_notifications_unread
  on public.user_notifications (lower(user_email), created_at desc)
  where read_at is null;

alter table public.user_notifications enable row level security;

-- Same shape as push_subscriptions_self: a user may only see/update
-- their own rows. All actual writes (fan-out on a new class/ebook/
-- routine) go through the service-role client in lib/webPush.ts —
-- this is a defense-in-depth backstop, not the enforcement mechanism.
drop policy if exists user_notifications_self on public.user_notifications;
create policy user_notifications_self on public.user_notifications
  for all using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  )
  with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );
