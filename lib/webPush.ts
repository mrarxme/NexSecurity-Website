import 'server-only';
import webpush from 'web-push';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

let vapidConfigured = false;

/** Lazily configures web-push with this deployment's VAPID keys, once.
 * Returns false (and logs once) if they haven't been set — lets every
 * caller just no-op instead of crashing when push isn't set up yet. */
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys are not configured — skipping. See scripts/README or the setup docs.');
    return false;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

/**
 * Sends the same notification to every subscribed device for the given
 * list of user emails. Best-effort per-device: one dead subscription
 * (expired, or the user revoked permission) never blocks delivery to
 * anyone else, and gets quietly deleted so future sends stop retrying it.
 */
export async function sendPushToEmails(
  emails: string[],
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  if (emails.length === 0 || !ensureVapidConfigured()) return;

  const adminClient = createSupabaseAdminClient();
  const lowerEmails = emails.map((e) => e.toLowerCase());
  const { data: subs, error } = await adminClient
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_email')
    .in('user_email', lowerEmails);

  if (error || !subs || subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Gone — the browser unsubscribed or the subscription expired.
          // Delete it so nothing keeps retrying a dead endpoint forever.
          await adminClient.from('push_subscriptions').delete().eq('id', sub.id);
        } else {
          console.error('[push] send failed for', sub.endpoint, statusCode, err instanceof Error ? err.message : err);
        }
      }
    })
  );
}

/**
 * Notifies everyone who can actually SEE a board that a new class was
 * just added to it — respecting the exact same access rules as the
 * board itself (see lib/boardAccess.ts): admins always, plus either
 * every active user (universal board) or only the ones explicitly
 * granted access (restricted board). The admin who just created the
 * class is excluded — they don't need a push about their own action.
 */
export async function notifyNewClass(boardId: string, videoTitle: string, videoId: string, createdByEmail: string): Promise<void> {
  const adminClient = createSupabaseAdminClient();

  const { data: board } = await adminClient.from('boards').select('title, visibility').eq('id', boardId).maybeSingle();
  if (!board) return;

  const { data: users } = await adminClient.from('authorized_users').select('email, role').eq('status', 'ACTIVE');
  if (!users || users.length === 0) return;

  let recipients: string[];
  if (board.visibility === 'restricted') {
    const { data: grants } = await adminClient.from('board_user_access').select('user_email').eq('board_id', boardId);
    const granted = new Set((grants ?? []).map((g) => g.user_email.toLowerCase()));
    recipients = users.filter((u) => u.role === 'ADMIN' || granted.has(u.email.toLowerCase())).map((u) => u.email);
  } else {
    recipients = users.map((u) => u.email);
  }

  recipients = recipients.filter((e) => e.toLowerCase() !== createdByEmail.toLowerCase());
  if (recipients.length === 0) return;

  await sendPushToEmails(recipients, {
    title: `New class in ${board.title}`,
    body: videoTitle,
    url: `/learn/video/${videoId}`,
  });
}
