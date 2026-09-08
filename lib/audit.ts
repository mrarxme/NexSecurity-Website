import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type AuditEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_DENIED'
  | 'USER_ADDED'
  | 'USER_REMOVED'
  | 'USER_DISABLED'
  | 'USER_ENABLED'
  | 'USER_ROLE_CHANGED'
  | 'ADMIN_ACTION'
  | 'BOARD_CREATED'
  | 'BOARD_UPDATED'
  | 'BOARD_DELETED'
  | 'BOARD_ACCESS_UPDATED'
  | 'VIDEO_ACCESS_GRANTED'
  | 'VIDEO_ACCESS_DENIED'
  | 'COMMENT_DELETED';

/**
 * Fire-and-forget audit log write. Deliberately swallows its own errors
 * so a logging failure can never block or crash the actual request —
 * but never logs secrets, tokens, or full request bodies.
 */
export async function logAuditEvent(
  eventType: AuditEventType,
  actorEmail: string | null,
  target?: string,
  metadata: Record<string, unknown> = {}
) {
  try {
    const supabase = createSupabaseAdminClient();
    await supabase.from('audit_logs').insert({
      event_type: eventType,
      actor_email: actorEmail,
      target: target ?? null,
      metadata,
    });
  } catch (err) {
    console.error('[audit] failed to write audit log', eventType, err);
  }
}
