import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getDeviceLabel } from '@/lib/requestInfo';
import { pushSubscriptionSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAuthorized();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const body = await request.json().catch(() => null);
  const parsed = pushSubscriptionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid subscription.' }, { status: 400 });

  const adminClient = createSupabaseAdminClient();
  const { error } = await adminClient.from('push_subscriptions').upsert(
    {
      user_email: auth.user.email.toLowerCase(),
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      device_label: getDeviceLabel(),
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' }
  );

  if (error) return NextResponse.json({ error: 'Could not save subscription.' }, { status: 400 });
  return NextResponse.json({ ok: true });
}

/** Called when the browser itself drops the subscription (e.g. the user
 * turned off notifications from browser settings) — removes the now-dead
 * row so nothing keeps trying to push to it. */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuthorized();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const body = await request.json().catch(() => null);
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : null;
  if (!endpoint) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });

  const adminClient = createSupabaseAdminClient();
  await adminClient.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_email', auth.user.email.toLowerCase());
  return NextResponse.json({ ok: true });
}
