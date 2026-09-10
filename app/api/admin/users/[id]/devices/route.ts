import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { deviceDecisionSchema, uuidSchema } from '@/lib/validation';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditEvent } from '@/lib/audit';
import { bestDeviceMatch } from '@/lib/deviceSimilarity';
import { describeDeviceSignals, type DeviceSignals } from '@/lib/deviceSignals';

export const dynamic = 'force-dynamic';

// A device counts as an active session if it's been seen inside this
// window — used only to badge "Active" in the admin panel's concurrent
// session view, never to decide authorization itself.
const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;

// user_devices has no SELECT policy for anyone but admins (see
// supabase/schema.sql) — read through the admin client, consistent with
// videos/e_books.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const adminClient = createSupabaseAdminClient();
  const { data: devices, error } = await adminClient
    .from('user_devices')
    .select(
      'id, device_id, ip_address, ip_history, device_label, status, label, approved_by, approved_at, first_seen, last_seen, created_at, signals'
    )
    .eq('user_id', parsedId.data)
    .order('last_seen', { ascending: false });

  if (error) return NextResponse.json({ error: 'Could not load devices.' }, { status: 400 });

  const activeCutoff = Date.now() - ACTIVE_SESSION_WINDOW_MS;
  const all = devices ?? [];
  const authorizedDevices = all.filter((d) => d.status === 'authorized');

  // For every pending device, find the best-matching ALREADY
  // AUTHORIZED device on this same account — this is what powers the
  // "likely the same laptop, different browser" hint in the admin
  // panel (see lib/deviceSimilarity.ts). Only pending rows need this;
  // authorized/restricted/blocked ones aren't waiting on a decision.
  const withActive = all.map((d) => {
    const isPending = d.status === 'pending';
    const match = isPending
      ? bestDeviceMatch(
          (d.signals ?? {}) as DeviceSignals,
          authorizedDevices.map((o) => ({ id: o.id, signals: (o.signals ?? {}) as DeviceSignals }))
        )
      : null;
    const matchedDevice = match ? authorizedDevices.find((o) => o.id === match.deviceRowId) : null;

    // Every device gets its own signal_rows — not just pending ones —
    // so the admin can open up an authorized/rejected/blocked device
    // and see its raw signal snapshot on its own, independent of
    // whether it happened to match anything (see
    // lib/deviceSignals.ts's describeDeviceSignals). The raw `signals`
    // blob itself (including the FingerprintJS visitorId, a long
    // opaque hash with no display value of its own) still isn't sent —
    // only this formatted, human-readable view of it.
    const signalRows = describeDeviceSignals((d.signals ?? {}) as DeviceSignals);
    const { signals: _signals, ...rest } = d;

    return {
      ...rest,
      is_active: d.status === 'authorized' && new Date(d.last_seen).getTime() >= activeCutoff,
      signal_rows: signalRows,
      likely_same_device: match
        ? {
            label: match.label,
            score: match.score,
            matched_signals: match.matchedSignals,
            comparisons: match.comparisons,
            same_browser_fingerprint: match.sameBrowserFingerprint,
            matched_device_label: matchedDevice?.label || matchedDevice?.device_label || null,
          }
        : null,
    };
  });

  return NextResponse.json({
    pending: withActive.filter((d) => d.status === 'pending'),
    authorized: withActive.filter((d) => d.status === 'authorized'),
    restricted: withActive.filter((d) => d.status === 'restricted'),
    blocked: withActive.filter((d) => d.status === 'blocked'),
    active_count: withActive.filter((d) => d.is_active).length,
  });
}

/** Decide (approve/reject/block) a device — a pending request or an
 * existing row for this user. */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const rl = checkRateLimit(`admin_mutate:${auth.user.email}`, 30, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const body = await request.json().catch(() => null);
  const parsed = deviceDecisionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input.' }, { status: 400 });

  const adminClient = createSupabaseAdminClient();
  // Stamp WHO made this decision — the authenticated admin from their own
  // verified session, never the client — so the device row can show
  // "Approved by admin@x.com" without a trip to audit_logs.
  const { data, error } = await adminClient
    .from('user_devices')
    .update({
      status: parsed.data.status,
      label: parsed.data.label ?? undefined,
      approved_by: auth.user.email,
      approved_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.device_id)
    .eq('user_id', parsedId.data)
    .select('id, status')
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Could not save device decision.' }, { status: 400 });
  }

  // Deciding on a device is what turns on enforcement for accounts that
  // haven't had it explicitly toggled yet — from that point on, only
  // authorized devices work; everything else needs an explicit decision.
  await adminClient
    .from('authorized_users')
    .update({ restrict_devices: true })
    .eq('id', parsedId.data)
    .eq('restrict_devices', false);

  await logAuditEvent('ADMIN_ACTION', auth.user.email, parsedId.data, {
    action: `DEVICE_${parsed.data.status.toUpperCase()}`,
    device_id: parsed.data.device_id,
  });

  return NextResponse.json({ device: data }, { status: 200 });
}
