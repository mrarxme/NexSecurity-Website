import { NextResponse, type NextRequest } from 'next/server';
import { getAuth, requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { uuidSchema, videoCommentSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { canAccessBoard } from '@/lib/boardAccess';

export const dynamic = 'force-dynamic';

/**
 * Comments on a class (video) page. Same auth + board-access gate as
 * /progress and /play — never trust that a caller reached this route
 * legitimately just because it's the one hit. Both GET and POST share
 * that gate, so it's pulled into a small helper rather than duplicated
 * twice in this file.
 *
 * Returns the video's board (id, published) on success so the caller
 * doesn't have to look it up a second time, or a ready-to-return
 * NextResponse on any failure.
 */
async function loadVideoBoardOrDeny(
  adminClient: ReturnType<typeof createSupabaseAdminClient>,
  videoId: string,
  userEmail: string,
  isAdmin: boolean
): Promise<{ board: { id: string; published: boolean } } | { deny: NextResponse }> {
  const { data: video } = await adminClient
    .from('videos')
    .select('id, board:board_id(id, published)')
    .eq('id', videoId)
    .maybeSingle();
  const board = video?.board as unknown as { id: string; published: boolean } | null;

  if (!video || !board || !board.published) {
    return { deny: NextResponse.json({ error: 'Access denied.' }, { status: 404 }) };
  }

  if (!(await canAccessBoard(adminClient, userEmail, board.id, isAdmin))) {
    return { deny: NextResponse.json({ error: 'Access denied.' }, { status: 404 }) };
  }

  return { board };
}

/** List comments on a class, oldest first (a conversation reads top to
 * bottom, same as chat/thread UIs elsewhere) — newest posts land at the
 * bottom of the list rather than pushing the oldest ones down. */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuthorized();
  if (!auth.ok) {
    return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });
  }

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }
  const videoId = parsedId.data;

  const adminClient = createSupabaseAdminClient();
  const gate = await loadVideoBoardOrDeny(adminClient, videoId, auth.user.email, auth.user.role === 'ADMIN');
  if ('deny' in gate) return gate.deny;

  const { data, error } = await adminClient
    .from('video_comments')
    .select('id, user_email, user_name, user_avatar_url, body, created_at, updated_at')
    .eq('video_id', videoId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Could not load comments.' }, { status: 500 });
  }

  return NextResponse.json({ comments: data ?? [] });
}

/** Post a new comment on a class. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  // getAuth() (not requireAuthorized()) specifically because this route
  // needs .profile (Google display name/avatar) to snapshot onto the
  // new row — see the doc comment on migration 0011 for why it's a
  // snapshot rather than a live join.
  const auth = await getAuth();
  if (auth.state === 'UNAUTHENTICATED') {
    return NextResponse.json({ error: 'Access denied.' }, { status: 401 });
  }
  if (auth.state === 'UNAUTHORIZED' || auth.state === 'DEVICE_BLOCKED') {
    return NextResponse.json({ error: 'Access denied.' }, { status: 403 });
  }

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }
  const videoId = parsedId.data;

  // Generous for a normal person chatting under a class, well under
  // this, while still stopping a scripted flood.
  const rl = checkRateLimit(`video_comments:${auth.email}`, 20, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests. Slow down.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const parsed = videoCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Comment cannot be empty.' }, { status: 400 });
  }

  const adminClient = createSupabaseAdminClient();
  const gate = await loadVideoBoardOrDeny(adminClient, videoId, auth.email, auth.user.role === 'ADMIN');
  if ('deny' in gate) return gate.deny;

  const { data, error } = await adminClient
    .from('video_comments')
    .insert({
      video_id: videoId,
      user_email: auth.email,
      user_name: auth.profile.fullName,
      user_avatar_url: auth.profile.avatarUrl,
      body: parsed.data.body,
    })
    .select('id, user_email, user_name, user_avatar_url, body, created_at, updated_at')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Could not post comment.' }, { status: 500 });
  }

  return NextResponse.json({ comment: data }, { status: 201 });
}
