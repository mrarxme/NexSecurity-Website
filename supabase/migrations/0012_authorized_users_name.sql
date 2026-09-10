-- Admins currently only have the email to go by when scanning the
-- Authorized users list, which gets confusing fast once there are more
-- than a handful of accounts (same problem the video_comments avatar
-- fix (0011) solved on the student side — a bare email is hard to place
-- at a glance). This adds an OPTIONAL display name an admin can set,
-- either when adding a user or later from Edit. Nullable and never
-- required: nothing about auth, login, or access control reads this
-- column — it's purely an admin-facing label. Falls back to showing the
-- email wherever it's blank (see app/admin/users/page.tsx).
alter table public.authorized_users
  add column if not exists name text;
