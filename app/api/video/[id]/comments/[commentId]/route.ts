import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { uuidSchema, videoCommentSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Delete a single comment. A regular user may delete only their OWN
 * comment; an ADMIN may delete any comment on any class (moderation) —
 * same self-or-admin shape RLS enforces on the table itself (see
 * supabase/migrations/0009_video_comments.sql), checked again here so
 * the route can tell the two cases apart and give the right response
 * (and only log an audit event for the moderation case, not every
 * ordinary self-delete).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string; commentId: string } }
) {
  const auth = await requireAuthorized();
  if (!auth.ok) {
    return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });
  }

  const parsedVideoId = uuidSchema.safeParse(params.id);
  const parsedCommentId = uuidSchema.safeParse(params.commentId);
  if (!parsedVideoId.success || !parsedCommentId.success) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }
  const videoId = parsedVideoId.data;
  const commentId = parsedCommentId.data;

  const adminClient = createSupabaseAdminClient();
  const isAdmin = auth.user.role === 'ADMIN';

  const { data: comment } = await adminClient
    .from('video_comments')
    .select('id, user_email')
    .eq('id', commentId)
    .eq('video_id', videoId)
    .maybeSingle();

  if (!comment) {
    return NextResponse.json({ error: 'Comment not found.' }, { status: 404 });
  }

  const isOwnComment = comment.user_email.toLowerCase() === auth.user.email.toLowerCase();
  if (!isOwnComment && !isAdmin) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 403 });
  }

  const { error } = await adminClient.from('video_comments').delete().eq('id', commentId).eq('video_id', videoId);
  if (error) {
    return NextResponse.json({ error: 'Could not delete comment.' }, { status: 500 });
  }

  // Only log when an admin is moderating someone else's comment —
  // deleting your own comment is an ordinary user action, not a
  // security/admin event (same distinction lib/audit.ts's own doc
  // comment draws for what belongs in this trail).
  if (isAdmin && !isOwnComment) {
    await logAuditEvent('COMMENT_DELETED', auth.user.email, videoId, { comment_id: commentId, comment_author: comment.user_email });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Edit a comment's own text. Owner-only (see migration 0011's UPDATE
 * policy) — unlike DELETE, this is never available to an admin editing
 * someone else's comment: moderating by silently rewriting what a
 * student said would misattribute words to them, which deleting a
 * comment doesn't do.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string; commentId: string } }) {
  const auth = await requireAuthorized();
  if (!auth.ok) {
    return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });
  }

  const parsedVideoId = uuidSchema.safeParse(params.id);
  const parsedCommentId = uuidSchema.safeParse(params.commentId);
  if (!parsedVideoId.success || !parsedCommentId.success) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 404 });
  }
  const videoId = parsedVideoId.data;
  const commentId = parsedCommentId.data;

  // Same allowance as posting a new comment — editing isn't a cheaper
  // action than writing one, so it shares that budget rather than
  // getting its own separate 20/min.
  const rl = checkRateLimit(`video_comments:${auth.user.email}`, 20, 60_000);
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

  const { data: comment } = await adminClient
    .from('video_comments')
    .select('id, user_email')
    .eq('id', commentId)
    .eq('video_id', videoId)
    .maybeSingle();

  if (!comment) {
    return NextResponse.json({ error: 'Comment not found.' }, { status: 404 });
  }
  if (comment.user_email.toLowerCase() !== auth.user.email.toLowerCase()) {
    return NextResponse.json({ error: 'Access denied.' }, { status: 403 });
  }

  const { data, error } = await adminClient
    .from('video_comments')
    .update({ body: parsed.data.body, updated_at: new Date().toISOString() })
    .eq('id', commentId)
    .eq('video_id', videoId)
    .select('id, user_email, user_name, user_avatar_url, body, created_at, updated_at')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Could not update comment.' }, { status: 500 });
  }

  return NextResponse.json({ comment: data });
}
