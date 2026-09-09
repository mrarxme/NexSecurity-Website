-- Extends video_comments (0009) with two things the UI now needs:
--
-- 1. A denormalized snapshot of the commenter's display name + avatar.
--    There's no `users` table in this schema to join against for that —
--    Google profile data (full_name/avatar_url) only ever lives in
--    Supabase's own auth.users.user_metadata, which client-side reads
--    can't join across per-comment (see lib/auth.ts's own comment on
--    why that lookup is server-only). Snapshotting it into the comment
--    row at post time is the same tradeoff every comment system with a
--    "who said this" avatar makes: if someone changes their Google
--    profile photo later, their older comments keep showing the old
--    one — acceptable, and far simpler than a live join. Nullable,
--    because comments posted before this migration won't have one; the
--    UI falls back to an initials avatar for those.
--
-- 2. An UPDATE policy — comments were explicitly non-editable in 0009;
--    this turns that on for the comment's own author only, matching the
--    self-or-admin shape used for DELETE (admins still can't edit
--    someone else's wording, only remove it — moderating a comment by
--    silently rewriting it would be a different, worse thing than
--    deleting it).
--
-- Run this once against any existing project. Safe to run multiple times.

alter table public.video_comments
  add column if not exists user_name text,
  add column if not exists user_avatar_url text,
  add column if not exists updated_at timestamptz not null default now();

drop policy if exists video_comments_update on public.video_comments;
create policy video_comments_update on public.video_comments
  for update using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) with check (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
