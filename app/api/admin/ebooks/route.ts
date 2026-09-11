import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { eBookSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';
import { notifyNewEbook } from '@/lib/webPush';

export const dynamic = 'force-dynamic';

// Uses the admin client deliberately: `e_books` has no SELECT policy for
// anyone (see supabase/schema.sql), by design, same as `videos` — only
// this service-role-backed, requireAdmin()-gated route can read it.
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const adminClient = createSupabaseAdminClient();
  const { data, error } = await adminClient
    .from('e_books')
    .select(
      'id, title, description, thumbnail_url, download_url, format, price, board_id, sort_order, board:board_id(id, title), created_at'
    )
    .order('board_id', { ascending: true })
    .order('sort_order', { ascending: true });

  if (error) return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  return NextResponse.json({ e_books: data });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = eBookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  }

  const adminClient = createSupabaseAdminClient();

  const { data, error } = await adminClient
    .from('e_books')
    .insert(parsed.data)
    .select('id, title')
    .single();

  if (error) {
    console.error('e_books insert failed:', error);
    return NextResponse.json({ error: 'Could not create e-book.' }, { status: 400 });
  }

  await logAuditEvent('ADMIN_ACTION', auth.user.email, data.id, {
    action: 'EBOOK_CREATED',
    title: data.title,
  });

  // Same fire-and-forget shape as notifyNewClass in
  // app/api/admin/videos/route.ts — never awaited, so a slow push
  // fan-out never delays the admin's own "created" response.
  void notifyNewEbook(parsed.data.board_id, data.title, auth.user.email).catch((err) => {
    console.error('[push] new-ebook notification failed', err);
  });

  return NextResponse.json({ e_book: data }, { status: 201 });
}
