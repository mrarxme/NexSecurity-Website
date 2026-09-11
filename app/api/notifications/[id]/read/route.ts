import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthorized } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { uuidSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Marks one notification read — called the moment the user clicks it
 * in the bell dropdown, right before navigating to its url (see
 * components/TopNav.tsx). Scoped to the caller's own email; there's no
 * legitimate reason for anyone (including an admin) to mark someone
 * else's notification read. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuthorized();
  if (!auth.ok) return NextResponse.json({ error: 'Access denied.' }, { status: auth.status });

  const parsedId = uuidSchema.safeParse(params.id);
  if (!parsedId.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });

  const adminClient = createSupabaseAdminClient();
  const { error } = await adminClient
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', parsedId.data)
    .eq('user_email', auth.user.email);

  if (error) return NextResponse.json({ error: 'Could not update notification.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
