import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { boardUpdateSchema, uuidSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';
import { notifyNewRoutine } from '@/lib/webPush';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = boardUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });

  const supabase = createSupabaseServerClient();

  // Fetched BEFORE the update specifically to compare published
  // before/after below — a PATCH here covers every board field
  // (title, visibility, published, ...), not just publishing, so the
  // only way to tell "this routine just went from draft to published"
  // apart from "someone re-saved an already-published routine's
  // description" is to know what it looked like a moment ago.
  const { data: before } = await supabase.from('boards').select('board_type, published').eq('id', parsedId.data).maybeSingle();

  const { data, error } = await supabase
    .from('boards')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', parsedId.data)
    .select('id, title')
    .maybeSingle();

  if (error || !data) return NextResponse.json({ error: 'Could not update board.' }, { status: 400 });

  await logAuditEvent('BOARD_UPDATED', auth.user.email, data.id);

  const justPublished = before && !before.published && parsed.data.published === true;
  const isRoutine = (parsed.data.board_type ?? before?.board_type) === 'routine';
  if (justPublished && isRoutine) {
    void notifyNewRoutine(data.id, data.title, auth.user.email).catch((err) => {
      console.error('[push] new-routine notification failed', err);
    });
  }

  return NextResponse.json({ board: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('boards').delete().eq('id', parsedId.data);
  if (error) return NextResponse.json({ error: 'Could not delete board.' }, { status: 400 });

  await logAuditEvent('BOARD_DELETED', auth.user.email, parsedId.data);
  return NextResponse.json({ ok: true });
}
