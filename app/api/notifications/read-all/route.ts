import { NextResponse } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/** "Mark all read" in the bell dropdown — clears every unread
 * notification for the caller's own account in one call instead of the
 * client looping one request per row. */
export async function POST() {
  const auth = await requireAuthorized();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const adminClient = createSupabaseAdminClient();
  const { error } = await adminClient
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_email', auth.user.email)
    .is('read_at', null);

  if (error) return NextResponse.json({ error: 'Could not update notifications.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
