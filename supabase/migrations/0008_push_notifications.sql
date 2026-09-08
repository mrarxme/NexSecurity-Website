-- Web Push subscriptions — one row per browser/device that's granted
-- notification permission, tied to the account it was subscribed under.
-- `endpoint` (the push service URL the browser gave us) is the natural
-- unique key: it's different for every browser/device/profile, and a
-- fresh subscribe from the same device after clearing site data just
-- gets a new endpoint rather than colliding with the old one.
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

alter table public.push_subscriptions enable row level security;

-- Same shape as video_progress / user_popup_views: a user may only see
-- their own subscription rows. All actual reads/writes go through the
-- service-role client in app/api/push/* and lib/webPush.ts regardless —
-- this is a defense-in-depth backstop, not the enforcement mechanism.
drop policy if exists push_subscriptions_self on public.push_subscriptions;
create policy push_subscriptions_self on public.push_subscriptions
  for all using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  )
  with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );
