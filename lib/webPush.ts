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
 * Sends the same push notification to every subscribed device for the
 * given list of user emails. Best-effort per-device: one dead
 * subscription (expired, or the user revoked permission) never blocks
 * delivery to anyone else, and gets quietly deleted so future sends
 * stop retrying it. This is ONLY the push half of delivery — see
 * notifyUsers() below for the combined push + in-app inbox write that
 * every actual notification event should go through instead of
 * calling this directly.
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
 * The one function every "something new was added" event should call.
 * Push (sendPushToEmails) only ever reaches a device that BOTH supports
 * the Push API AND currently has an active subscription — plenty of
 * real devices have neither (iOS Safari outside an installed PWA has no
 * Push API at all; anyone who hasn't clicked "Enable" yet has no
 * subscription). Writing to user_notifications (0013) as well means
 * every recipient sees it in the in-app bell (components/TopNav.tsx)
 * the next time they open the app, regardless of push support — push
 * is the "even if the app is fully closed" path, the inbox is the
 * "definitely see it eventually" path, and every event needs both.
 *
 * Best-effort like sendPushToEmails: the in-app insert and the push
 * send never block or fail each other.
 */
export async function notifyUsers(
  emails: string[],
  payload: { type: 'class' | 'ebook' | 'routine'; title: string; body: string; url: string }
): Promise<void> {
  if (emails.length === 0) return;

  const adminClient = createSupabaseAdminClient();
  const rows = emails.map((email) => ({
    user_email: email,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    url: payload.url,
  }));

  await Promise.all([
    adminClient.from('user_notifications').insert(rows),
    sendPushToEmails(emails, { title: payload.title, body: payload.body, url: payload.url }),
  ]);
}

/**
 * Who should hear about something new on this board — the shared rule
 * behind notifyNewClass/notifyNewEbook/notifyNewRoutine below: admins
 * always, plus either every active user (universal board) or only the
 * ones explicitly granted access (restricted board) — same access rule
 * the board itself enforces (see lib/boardAccess.ts). The admin who
 * just created the thing is excluded — they don't need a notification
 * about their own action.
 */
async function getBoardRecipients(boardId: string, excludeEmail: string): Promise<{ boardTitle: string; recipients: string[] } | null> {
  const adminClient = createSupabaseAdminClient();

  const { data: board } = await adminClient.from('boards').select('title, visibility').eq('id', boardId).maybeSingle();
  if (!board) return null;

  const { data: users } = await adminClient.from('authorized_users').select('email, role').eq('status', 'ACTIVE');
  if (!users || users.length === 0) return { boardTitle: board.title, recipients: [] };

  let recipients: string[];
  if (board.visibility === 'restricted') {
    const { data: grants } = await adminClient.from('board_user_access').select('user_email').eq('board_id', boardId);
    const granted = new Set((grants ?? []).map((g) => g.user_email.toLowerCase()));
    recipients = users.filter((u) => u.role === 'ADMIN' || granted.has(u.email.toLowerCase())).map((u) => u.email);
  } else {
    recipients = users.map((u) => u.email);
  }

  recipients = recipients.filter((e) => e.toLowerCase() !== excludeEmail.toLowerCase());
  return { boardTitle: board.title, recipients };
}

/** Notifies everyone who can see a board that a new class just went up on it. */
export async function notifyNewClass(boardId: string, videoTitle: string, videoId: string, createdByEmail: string): Promise<void> {
  const result = await getBoardRecipients(boardId, createdByEmail);
  if (!result || result.recipients.length === 0) return;

  await notifyUsers(result.recipients, {
    type: 'class',
    title: `New class in ${result.boardTitle}`,
    body: videoTitle,
    url: `/learn/video/${videoId}`,
  });
}

/** Notifies everyone who can see a board that a new e-book was added to it. */
export async function notifyNewEbook(boardId: string, ebookTitle: string, createdByEmail: string): Promise<void> {
  const result = await getBoardRecipients(boardId, createdByEmail);
  if (!result || result.recipients.length === 0) return;

  await notifyUsers(result.recipients, {
    type: 'ebook',
    title: `New e-book in ${result.boardTitle}`,
    body: ebookTitle,
    // e-books don't have their own page — they're listed alongside
    // their board on /learn/ebooks (see app/learn/ebooks/page.tsx).
    url: '/learn/ebooks',
  });
}

/** Notifies everyone who can see a board that a new/updated routine was published. */
export async function notifyNewRoutine(boardId: string, routineTitle: string, createdByEmail: string): Promise<void> {
  const result = await getBoardRecipients(boardId, createdByEmail);
  if (!result || result.recipients.length === 0) return;

  await notifyUsers(result.recipients, {
    type: 'routine',
    title: 'Routine updated',
    body: routineTitle,
    // Same reasoning as e-books above — routines are boards with
    // board_type='routine', all listed together on one page (see
    // app/learn/routines/page.tsx), no individual per-routine URL.
    url: '/learn/routines',
  });
}
