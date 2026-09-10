import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { updateAuthorizedUserSchema, uuidSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = updateAuthorizedUserSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });

  const supabase = createSupabaseServerClient();

  const { data: target } = await supabase
    .from('authorized_users')
    .select('id, email, account_type, trial_expires_at')
    .eq('id', parsedId.data)
    .maybeSingle();

  if (!target) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  // Prevent an admin from demoting/disabling their own account by
  // accident (a real self-lockout footgun, not a security bypass).
  if (target.email.toLowerCase() === auth.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "You can't change your own role or status." },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  // '' means "clear the name" from the edit UI — store that as null
  // rather than an empty string (matches how it's inserted on create).
  if ('name' in parsed.data) {
    patch.name = parsed.data.name || null;
  }

  // Manually re-activating a trial account that had already expired is
  // an explicit admin override — clear the expiry so it doesn't just get
  // auto-disabled again on the user's very next request. account_type
  // stays 'trial' (it's still true, for reporting), only the ENFORCED
  // cutoff goes away; give them another trial window instead by editing
  // trial_duration_minutes and clearing trial_started_at.
  if (parsed.data.status === 'ACTIVE' && target.account_type === 'trial' && target.trial_expires_at) {
    patch.trial_expires_at = null;
  }

  const { data: updated, error } = await supabase
    .from('authorized_users')
    .update(patch)
    .eq('id', parsedId.data)
    .select('id, email, name, role, status')
    .single();

  if (error) return NextResponse.json({ error: 'Could not update user.' }, { status: 400 });

  if (parsed.data.status === 'DISABLED') {
    await logAuditEvent('USER_DISABLED', auth.user.email, target.email);
  } else if (parsed.data.status === 'ACTIVE') {
    await logAuditEvent('USER_ENABLED', auth.user.email, target.email);
  }
  if (parsed.data.role) {
    await logAuditEvent('USER_ROLE_CHANGED', auth.user.email, target.email, {
      role: parsed.data.role,
    });
  }

  return NextResponse.json({ user: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const supabase = createSupabaseServerClient();
  const { data: target } = await supabase
    .from('authorized_users')
    .select('id, email')
    .eq('id', parsedId.data)
    .maybeSingle();

  if (!target) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  if (target.email.toLowerCase() === auth.user.email.toLowerCase()) {
    return NextResponse.json({ error: "You can't remove your own account." }, { status: 400 });
  }

  const { error } = await supabase.from('authorized_users').delete().eq('id', parsedId.data);
  if (error) return NextResponse.json({ error: 'Could not remove user.' }, { status: 400 });

  await logAuditEvent('USER_REMOVED', auth.user.email, target.email);
  return NextResponse.json({ ok: true });
}
