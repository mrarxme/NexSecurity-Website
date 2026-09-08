-- Comments on a class (video) page. Flat (no nested replies) — there's
-- no existing threading pattern anywhere else in this app to justify
-- one, and the simpler shape is easier to moderate. Same per-video,
-- per-user convention as video_progress (user_email + video_id), which
-- is the closest existing precedent for this kind of table.
--
-- Run this once against any existing project. Safe to run multiple times.

create table if not exists public.video_comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  user_email text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_video_comments_video_created on public.video_comments (video_id, created_at);

alter table public.video_comments enable row level security;

-- INSERT: any ACTIVE authorized user may comment, but ONLY on a video
-- whose board they can actually reach — reusing the exact same
-- cascading "restricted board" rule as everywhere else (canAccessBoard
-- in lib/boardAccess.ts). RLS can't call that TS helper directly, so
-- this policy re-derives the same walk-up-the-parent-chain logic in SQL
-- via a small helper function below, rather than duplicating the rule
-- as a flat (and therefore looser) check here.
--
-- In practice, every write from the app goes through the API routes
-- under app/api/video/[id]/comments/, which call canAccessBoard()
-- themselves before ever touching the table (same defense-in-depth
-- shape as video_progress) — this policy is the real backstop in case
-- that ever changes or a client talks to PostgREST directly.
create or replace function public.can_access_board(check_board_id uuid, check_email text) returns boolean as $$
declare
  current_id uuid := check_board_id;
  depth int := 0;
  board_visibility text;
  board_parent uuid;
  has_grant boolean;
begin
  if public.is_admin() then
    return true;
  end if;

  while current_id is not null and depth < 20 loop
    select visibility, parent_id into board_visibility, board_parent
    from public.boards where id = current_id;

    -- A dangling/missing ancestor: deny rather than silently skip past it,
    -- same "can't verify it's safe" stance as lib/boardAccess.ts.
    if board_visibility is null then
      return false;
    end if;

    if board_visibility = 'restricted' then
      select exists (
        select 1 from public.board_user_access
        where board_id = current_id and lower(user_email) = lower(check_email)
      ) into has_grant;
      if not has_grant then
        return false;
      end if;
    end if;

    current_id := board_parent;
    depth := depth + 1;
  end loop;

  return true;
end;
$$ language plpgsql stable security definer set search_path = public;

drop policy if exists video_comments_insert on public.video_comments;
create policy video_comments_insert on public.video_comments
  for insert with check (
    public.is_authorized()
    and lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and exists (
      select 1 from public.videos v
      where v.id = video_id
        and public.can_access_board(v.board_id, coalesce(auth.jwt() ->> 'email', ''))
    )
  );

-- SELECT: any authorized user with access to a comment's video may read
-- it — same board-access gate as INSERT, just without the "own email"
-- restriction, since comments are visible to the whole class.
drop policy if exists video_comments_select on public.video_comments;
create policy video_comments_select on public.video_comments
  for select using (
    public.is_admin()
    or (
      public.is_authorized()
      and exists (
        select 1 from public.videos v
        where v.id = video_id
          and public.can_access_board(v.board_id, coalesce(auth.jwt() ->> 'email', ''))
      )
    )
  );

-- DELETE: a user may remove their own comment; an admin may remove any
-- comment (moderation) — same self-or-admin shape used throughout this
-- schema (video_progress, user_popup_views, push_subscriptions).
drop policy if exists video_comments_delete on public.video_comments;
create policy video_comments_delete on public.video_comments
  for delete using (
    lower(user_email) = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin()
  );

-- No UPDATE policy: comments aren't editable for now (per the brief) —
-- deleting and re-posting is the only way to "fix" one.
