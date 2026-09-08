import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { videoSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';
import { notifyNewClass } from '@/lib/webPush';

export const dynamic = 'force-dynamic';

// This uses the admin client deliberately: `videos` has no SELECT policy
// for anyone (see supabase/schema.sql), by design, so even an admin's
// normal RLS-scoped session client can't read it - only this
// service-role-backed, requireAdmin()-gated route can.
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const adminClient = createSupabaseAdminClient();
  const { data, error } = await adminClient
    .from('videos')
    .select(
      'id, title, description, thumbnail_url, provider, source_ref, referer_header, board_id, sort_order, download_url, board:board_id(id, title), created_at, video_resources(id, title, url, sort_order)'
    )
    .order('board_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (error) return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  return NextResponse.json({ videos: data });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = videoSchema.safeParse(body);
  if (!parsed.success) {
    // Admin-only, already-authenticated route (requireAdmin() above), so
    // surfacing which field failed and why is safe and saves guessing —
    // matches the same reasoning as the upload route's error response.
    console.error('videos POST validation failed:', JSON.stringify(parsed.error.flatten()));
    return NextResponse.json(
      { error: 'Invalid input.', details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const adminClient = createSupabaseAdminClient();

  const { data, error } = await adminClient
    .from('videos')
    .insert(parsed.data)
    .select('id, title')
    .single();

  if (error) {
    console.error('videos insert failed:', error);
    return NextResponse.json({ error: 'Could not create video.' }, { status: 400 });
  }

  await logAuditEvent('ADMIN_ACTION', auth.user.email, data.id, {
    action: 'VIDEO_CREATED',
    title: data.title,
  });

  // Fire-and-forget: tell everyone who can see this board that a new
  // class just went up. Never awaited — a slow push fan-out (or one dead
  // subscription in it) should never delay the admin's own "created"
  // response.
  void notifyNewClass(parsed.data.board_id, data.title, data.id, auth.user.email).catch((err) => {
    console.error('[push] new-class notification failed', err);
  });

  return NextResponse.json({ video: data }, { status: 201 });
}
