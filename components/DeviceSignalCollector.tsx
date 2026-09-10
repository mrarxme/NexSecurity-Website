'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { collectDeviceSignals } from '@/lib/deviceSignals';

// Module-level (not localStorage) — deliberately reset on every full
// page load, never persisted across them. An earlier version of this
// used a localStorage timestamp to only report once per 24h, but that
// key lives on the BROWSER/origin, not on the account — removing a
// user and re-adding them (or just switching accounts) on the same
// browser left the old timestamp behind, so the new account's device
// silently never got its signals reported for up to 24h, and the
// admin panel's "likely same device" hint had nothing to compare
// against. A full reload (which sign-in/sign-out always causes here,
// since Google OAuth is a full-navigation redirect) is what's actually
// meant to trigger a fresh report, so a plain in-memory flag for "have
// we already reported this page load" is both simpler and correct —
// no stale cross-account state to worry about, and the 10-req/min
// server-side rate limit in app/api/device/signals/route.ts already
// guards against any client-side re-render loop calling this
// repeatedly.
let reportedThisPageLoad = false;

/**
 * Mounted once in app/layout.tsx, same as NotificationPrompt/SitePopup.
 * Silently (no visible UI) reports this browser's best-effort
 * hardware/OS signals so an admin reviewing a "New Device Request" can
 * see whether it's likely the SAME physical machine as one they've
 * already approved, just a different browser — see
 * lib/deviceSimilarity.ts and app/api/device/signals/route.ts.
 *
 * Skips /login — EXCEPT the one case that actually matters most here:
 * every DEVICE_BLOCKED page in app/ redirects to exactly
 * `/login?error=device_blocked` (see e.g. app/learn/layout.tsx). That
 * landing is precisely a pending/restricted device that needs its
 * signals reported — skipping all of /login unconditionally meant a
 * pending device could sit blocked indefinitely and NEVER get a chance
 * to report anything, so the "likely same device" hint had nothing to
 * compare and always came back empty regardless of how long an admin
 * waited. Plain /login (no session yet) is still skipped — nothing
 * would succeed there anyway. api/device/signals/route.ts uses
 * requireDeviceIdentity() (not requireAuthorized()) specifically so
 * this request isn't rejected by the very restriction it's reporting
 * on. Everything here is best-effort either way: a failed collect or a
 * failed POST just means this device shows fewer signals to compare
 * against, never a broken sign-in or page load.
 */
export function DeviceSignalCollector() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isDeviceBlockedLanding = pathname === '/login' && searchParams.get('error') === 'device_blocked';
  const skip = pathname?.startsWith('/login') && !isDeviceBlockedLanding;

  useEffect(() => {
    if (skip) return;
    if (reportedThisPageLoad) return;

    let cancelled = false;
    (async () => {
      try {
        const signals = await collectDeviceSignals();
        if (cancelled) return;
        const res = await fetch('/api/device/signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signals),
        });
        if (res.ok) reportedThisPageLoad = true;
      } catch {
        // Best-effort — see file doc comment above. Leaving the flag
        // unset on failure means it'll simply retry on the next
        // mount/navigation rather than getting stuck "reported" when
        // it wasn't.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skip]);

  return null;
}
