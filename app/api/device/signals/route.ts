import { NextResponse, type NextRequest } from 'next/server';
import { requireDeviceIdentity } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { deviceSignalsSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * Receives the best-effort browser/hardware signals
 * components/DeviceSignalCollector.tsx gathers via
 * lib/deviceSignals.ts and merges them into this user's row for the
 * CURRENT device_id (planted by middleware.ts — see lib/deviceId.ts).
 *
 * Uses requireDeviceIdentity(), NOT requireAuthorized() — deliberately.
 * This must keep working even when THIS device is pending/restricted/
 * blocked, since a pending device reporting its own signals is exactly
 * what lets lib/deviceSimilarity.ts later tell an admin "this looks
 * like the same laptop as one you already approved, just a different
 * browser." Gating this behind requireAuthorized() would mean a
 * pending device's signals-report request gets rejected by the very
 * restriction it exists to help evaluate — the hint would never have
 * anything to compare, no matter how long the device sat pending.
 *
 * This intentionally does NOT touch status/approval — signals are pure
 * metadata for lib/deviceSimilarity.ts to compare against later. A
 * device row must already exist for this (user_id, device_id) pair —
 * getAuth() creates one on the very first request from any device,
 * authorized or not, well before this component ever mounts — so
 * there's nothing to insert here, only to enrich.
 */
export async function POST(request: NextRequest) {
  const auth = await requireDeviceIdentity();
  if (!auth.ok) {
    return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });
  }

  // This fires at most once per page load in practice — generous
  // headroom over that, mainly to stop a scripted loop. Keyed by
  // userId rather than email since that's all requireDeviceIdentity()
  // guarantees for a blocked device.
  const rl = checkRateLimit(`device_signals:${auth.userId}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
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
    .eq('user_id', auth.userId)
    .eq('device_id', auth.deviceId);

  if (error) {
    return NextResponse.json({ error: 'Could not save device signals.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
