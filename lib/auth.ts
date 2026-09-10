import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getClientIp, getDeviceLabel, getDeviceId } from '@/lib/requestInfo';

export type AuthorizedUser = {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'DISABLED';
  restrict_devices: boolean;
  account_type: 'paid' | 'trial';
  trial_duration_minutes: number | null;
  trial_started_at: string | null;
  trial_expires_at: string | null;
};

export type DeviceStatus = 'pending' | 'authorized' | 'restricted' | 'blocked';

export type GoogleProfile = { avatarUrl: string | null; fullName: string | null };

export type AuthResult =
  | { state: 'UNAUTHENTICATED' }
  | { state: 'UNAUTHORIZED'; email: string }
  | {
      state: 'DEVICE_BLOCKED';
      email: string;
      ip: string;
      deviceLabel: string;
      deviceStatus: DeviceStatus | 'unknown';
      // Needed by requireDeviceIdentity() below — a blocked/pending
      // device still needs to be identifiable so it can report its own
      // signals (see that function's doc comment for why). deviceId is
      // null only in the "cookie hasn't round-tripped yet" edge case,
      // where there's no row to attach anything to regardless.
      userId: string;
      deviceId: string | null;
    }
  | { state: 'AUTHORIZED'; email: string; user: AuthorizedUser; profile: GoogleProfile };

/** How many recent {ip, at} entries to keep per device. Bounded so a
 * device that roams a lot doesn't grow this row forever — an admin
 * reviewing a device only needs recent history, not a full log
 * (audit_logs is where a full trail belongs). */
const IP_HISTORY_LIMIT = 20;

/**
 * Finds (or creates, as 'pending') this user's row for THIS device_id,
 * records the current IP into its history, and returns the device's
 * current status.
 *
 * device_id — not IP, not User-Agent — is the device's identity (see
 * lib/deviceId.ts). This is what makes "1 account = unlimited devices"
 * actually work: the same phone stays the same device across a wifi ->
 * mobile-data switch, instead of looking like a brand-new device every
 * time its IP changes.
 *
 * Called for EVERY authorized request, regardless of whether
 * restrict_devices is on, so an admin reviewing a suspicious account (or
 * turning restriction on for the first time) has real device history to
 * decide from instead of a blank list. Never throws into the caller.
 */
async function upsertDeviceAndGetStatus(
  user: AuthorizedUser,
  deviceId: string,
  ip: string,
  deviceLabel: string
): Promise<DeviceStatus> {
  const userId = user.id;
  try {
    const adminClient = createSupabaseAdminClient();
    const nowIso = new Date().toISOString();

    const { data: existing } = await adminClient
      .from('user_devices')
      .select('id, status, ip_history')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existing) {
      const history: { ip: string; at: string }[] = Array.isArray(existing.ip_history)
        ? existing.ip_history
        : [];
      const alreadyKnown = history.some((entry) => entry.ip === ip);
      const nextHistory = alreadyKnown
        ? history
        : [...history, { ip, at: nowIso }].slice(-IP_HISTORY_LIMIT);

      await adminClient
        .from('user_devices')
        .update({
          last_seen: nowIso,
          ip_address: ip,
          ip_history: nextHistory,
          device_label: deviceLabel,
        })
        .eq('id', existing.id);

      return existing.status as DeviceStatus;
    }

    // Never seen before for this user. If this account has NO other
    // device rows at all, this is their very first device ever — the
    // moment their email was authorized and they signed in for the
    // first time — and gets auto-approved so a brand-new user isn't
    // blocked on their own first login. Every device after that first
    // one still lands as 'pending', same as always.
    const { count: existingDeviceCount } = await adminClient
      .from('user_devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    const isFirstDeviceEver = !existingDeviceCount || existingDeviceCount === 0;
    const initialStatus: DeviceStatus = isFirstDeviceEver ? 'authorized' : 'pending';

    await adminClient.from('user_devices').insert({
      user_id: userId,
      device_id: deviceId,
      ip_address: ip,
      ip_history: [{ ip, at: nowIso }],
      device_label: deviceLabel,
      status: initialStatus,
      label: isFirstDeviceEver ? 'First device (auto-approved)' : null,
      first_seen: nowIso,
      last_seen: nowIso,
    });

    // Free Trial: the countdown starts at this exact moment — the
    // account's first-ever login — not whenever the admin happened to
    // create the row. Only ever stamped once (guarded by
    // trial_started_at already being null); every login after the first
    // leaves it untouched.
    if (isFirstDeviceEver && user.account_type === 'trial' && !user.trial_started_at && user.trial_duration_minutes) {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + user.trial_duration_minutes * 60_000);
      await adminClient
        .from('authorized_users')
        .update({ trial_started_at: startedAt.toISOString(), trial_expires_at: expiresAt.toISOString() })
        .eq('id', userId);
    }

    return initialStatus;
  } catch (err) {
    console.error('[auth] failed to upsert device', err);
    // Fail closed only for the caller that actually cares (restricted
    // accounts check the return value); for unrestricted accounts this
    // is fire-and-forget and the error never reaches anyone.
    return 'pending';
  }
}

/**
 * THE security boundary. Every protected Server Component and Route
 * Handler must call this and branch on the result before touching any
 * protected data. Nothing about this function trusts the client:
 *  - the session itself is re-validated against Supabase Auth (server-side)
 *  - the email is looked up in authorized_users through RLS, which only
 *    lets the caller see their own row (see supabase/schema.sql)
 *  - if that account has restrict_devices on, the request's device_id
 *    (see lib/deviceId.ts) must have status 'authorized' in
 *    user_devices — an admin explicitly approved it — or the request is
 *    DEVICE_BLOCKED. This is what stops one account being shared across
 *    many people's devices at once (see app/admin/users/[id]/page.tsx
 *    and components/VideoPlayer.tsx's heartbeat, which re-runs this
 *    check periodically during playback so an already-open tab gets cut
 *    off too, not just future page loads).
 *
 * A user reaching this point with a valid session but no ACTIVE row in
 * authorized_users is UNAUTHORIZED, full stop — regardless of anything
 * the frontend, cookies, or request claims.
 */
export async function getAuth(): Promise<AuthResult> {
  const supabase = createSupabaseServerClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user || !user.email) {
    return { state: 'UNAUTHENTICATED' };
  }

  const { data: authorizedUser } = await supabase
    .from('authorized_users')
    .select('id, email, role, status, restrict_devices, account_type, trial_duration_minutes, trial_started_at, trial_expires_at')
    .eq('email', user.email.toLowerCase())
    .maybeSingle();

  if (!authorizedUser || authorizedUser.status !== 'ACTIVE') {
    return { state: 'UNAUTHORIZED', email: user.email };
  }

  // Free Trial expiry — checked on every request rather than a background
  // job (there's no cron/scheduler in this stack): functionally the same
  // thing, since there's nothing to expire while nobody's making
  // requests anyway. The instant a trial account's clock runs out, their
  // very next request auto-disables the account instead of letting it
  // through — an admin can re-enable it manually later from Users (doing
  // so also clears the expiry so it doesn't immediately re-trigger).
  if (
    authorizedUser.account_type === 'trial' &&
    authorizedUser.trial_expires_at &&
    new Date(authorizedUser.trial_expires_at).getTime() <= Date.now()
  ) {
    const adminClient = createSupabaseAdminClient();
    await adminClient.from('authorized_users').update({ status: 'DISABLED' }).eq('id', authorizedUser.id);
    return { state: 'UNAUTHORIZED', email: user.email };
  }

  // Google's profile photo/name come from the OAuth identity itself
  // (Supabase stores them in user_metadata) — not from our own
  // authorized_users table, which has no such columns. Pulled here, once,
  // server-side, since we already have `user` in hand from the
  // getUser() call above — this is what lets TopNav render the real
  // avatar on the very first paint instead of a client-side follow-up
  // fetch to get the same data a second time.
  const meta = user.user_metadata as { avatar_url?: string; picture?: string; full_name?: string } | undefined;
  const profile: GoogleProfile = {
    avatarUrl: meta?.avatar_url ?? meta?.picture ?? null,
    fullName: meta?.full_name ?? null,
  };

  const typedUser = authorizedUser as AuthorizedUser;
  const ip = getClientIp();
  const deviceLabel = getDeviceLabel();
  const deviceId = getDeviceId();

  const isRestricted = typedUser.restrict_devices && typedUser.role !== 'ADMIN';

  if (!deviceId) {
    // The device-identity cookie hasn't round-tripped to the browser yet
    // (see lib/deviceId.ts) — extremely rare in practice, since it's
    // planted on every path including the OAuth redirect chain that gets
    // a user here in the first place. Only accounts under restriction
    // need to care; treat it as "not yet approved" rather than guessing.
    if (isRestricted) {
      return { state: 'DEVICE_BLOCKED', email: user.email, ip, deviceLabel, deviceStatus: 'unknown', userId: typedUser.id, deviceId: null };
    }
    return { state: 'AUTHORIZED', email: user.email, user: typedUser, profile };
  }

  if (isRestricted) {
    // Restriction is on for this account: the status decision gates
    // access, so it must be awaited before we can answer.
    const status = await upsertDeviceAndGetStatus(typedUser, deviceId, ip, deviceLabel);
    if (status !== 'authorized') {
      return { state: 'DEVICE_BLOCKED', email: user.email, ip, deviceLabel, deviceStatus: status, userId: typedUser.id, deviceId };
    }
  } else {
    // Not restricted — still record the sighting so an admin has real
    // device history to review the moment they turn restriction on, but
    // don't make this request wait on it.
    void upsertDeviceAndGetStatus(typedUser, deviceId, ip, deviceLabel);
  }

  return {
    state: 'AUTHORIZED',
    email: user.email,
    user: typedUser,
    profile,
  };
}

/** Convenience guard for routes/pages that require ANY authorized user. */
export async function requireAuthorized(): Promise<
  { ok: true; user: AuthorizedUser } | { ok: false; status: 401 | 403 }
> {
  const auth = await getAuth();
  if (auth.state === 'UNAUTHENTICATED') return { ok: false, status: 401 };
  if (auth.state === 'UNAUTHORIZED') return { ok: false, status: 403 };
  if (auth.state === 'DEVICE_BLOCKED') return { ok: false, status: 403 };
  return { ok: true, user: auth.user };
}

/**
 * Narrower than requireAuthorized() on purpose: a PENDING (or
 * restricted/blocked) device is exactly what an admin needs a "likely
 * same physical device" hint for (see lib/deviceSimilarity.ts) — but
 * that hint can only exist if the device gets a chance to report its
 * own signals in the first place, and requireAuthorized() rejects
 * DEVICE_BLOCKED outright. Using that for /api/device/signals meant a
 * pending device's very own signals-report request was itself blocked
 * by the same restriction it was trying to help evaluate — nothing
 * ever got saved, so the hint always came back empty. This lets a
 * device identify itself and report signals regardless of its
 * status, while still fully rejecting anyone without a valid,
 * ACTIVE account (UNAUTHENTICATED/UNAUTHORIZED) — the one thing this
 * never does is grant access to anything else. Only
 * app/api/device/signals/route.ts should use this.
 */
export async function requireDeviceIdentity(): Promise<
  { ok: true; userId: string; deviceId: string } | { ok: false; status: 401 | 403 | 409 }
> {
  const auth = await getAuth();
  if (auth.state === 'UNAUTHENTICATED') return { ok: false, status: 401 };
  if (auth.state === 'UNAUTHORIZED') return { ok: false, status: 403 };
  if (auth.state === 'DEVICE_BLOCKED') {
    if (!auth.deviceId) return { ok: false, status: 409 };
    return { ok: true, userId: auth.userId, deviceId: auth.deviceId };
  }
  const deviceId = getDeviceId();
  if (!deviceId) return { ok: false, status: 409 };
  return { ok: true, userId: auth.user.id, deviceId };
}

/** Convenience guard for routes/pages that require an ADMIN. */
export async function requireAdmin(): Promise<
  { ok: true; user: AuthorizedUser } | { ok: false; status: 401 | 403 }
> {
  const result = await requireAuthorized();
  if (!result.ok) return result;
  if (result.user.role !== 'ADMIN') return { ok: false, status: 403 };
  return result;
}
