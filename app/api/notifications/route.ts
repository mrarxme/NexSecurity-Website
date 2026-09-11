import { NextResponse } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * The in-app notification bell's data source (components/TopNav.tsx) —
 * see supabase/migrations/0013_user_notifications.sql for why this
 * exists alongside push. Only ever returns UNREAD notifications: once
 * one is marked read (opened, or "mark all read"), it's meant to just
 * stop appearing rather than needing a separate "hide" step — there's
 * no read-history view in this app.
 */
export async function GET() {
  const auth = await requireAuthorized();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const adminClient = createSupabaseAdminClient();
  const { data, error } = await adminClient
    .from('user_notifications')
    .select('id, type, title, body, url, created_at')
    .eq('user_email', auth.user.email)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    // A generous cap, not a real pagination limit — nobody is expected
    // to accumulate more than this many unread at once given classes/
    // ebooks/routines are added at a normal admin's pace, not a firehose.
    .limit(50);

  if (error) return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  return NextResponse.json({ notifications: data });
}
