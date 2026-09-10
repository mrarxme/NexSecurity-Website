import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { addAuthorizedUserSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('authorized_users')
    .select('id, email, name, role, status, restrict_devices, account_type, trial_duration_minutes, trial_started_at, trial_expires_at, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  return NextResponse.json({ users: data });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = addAuthorizedUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('authorized_users')
    .insert({
      email: parsed.data.email,
      name: parsed.data.name || null,
      role: parsed.data.role,
      status: 'ACTIVE',
      restrict_devices: parsed.data.role !== 'ADMIN',
      account_type: parsed.data.account_type,
      // Only ever set for a genuine trial account — trial_started_at /
      // trial_expires_at stay null until first login (see lib/auth.ts).
      trial_duration_minutes: parsed.data.account_type === 'trial' ? parsed.data.trial_duration_minutes : null,
    })
    .select('id, email, name, role, status, account_type, trial_duration_minutes')
    .single();

  if (error) {
    // Don't leak whether it failed because the email already exists vs.
    // some other DB error — generic message either way.
    return NextResponse.json({ error: 'Could not add user.' }, { status: 400 });
  }

  await logAuditEvent('USER_ADDED', auth.user.email, parsed.data.email, {
    role: parsed.data.role,
    account_type: parsed.data.account_type,
  });

  return NextResponse.json({ user: data }, { status: 201 });
}
