import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { deviceSignalsSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { getDeviceId } from '@/lib/requestInfo';

export const dynamic = 'force-dynamic';

/**
 * Receives the best-effort browser/hardware signals
 * components/DeviceSignalCollector.tsx gathers via
 * lib/deviceSignals.ts and merges them into this user's row for the
 * CURRENT device_id (planted by middleware.ts — see lib/deviceId.ts).
 *
 * This intentionally does NOT touch status/approval — signals are pure
 * metadata for lib/deviceSimilarity.ts to compare against later. A
 * device row must already exist for this (user_id, device_id) pair —
 * getAuth() creates one on the very first authorized request, well
 * before this component ever mounts — so there's nothing to insert
 * here, only to enrich.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuthorized();
  if (!auth.ok) {
    return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });
  }

  // This fires at most once per page load in practice — generous
  // headroom over that, mainly to stop a scripted loop.
  const rl = checkRateLimit(`device_signals:${auth.user.email}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
  }

  const deviceId = getDeviceId();
  if (!deviceId) {
    // Same "identity not yet established" case getAuth() itself
    // handles — nothing to attach these signals to yet.
    return NextResponse.json({ error: 'Device identity not established yet.' }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const parsed = deviceSignalsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid signals payload.' }, { status: 400 });
  }

  const adminClient = createSupabaseAdminClient();
  const { error } = await adminClient
    .from('user_devices')
    .update({ signals: parsed.data })
    .eq('user_id', auth.user.id)
    .eq('device_id', deviceId);

  if (error) {
    return NextResponse.json({ error: 'Could not save device signals.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
