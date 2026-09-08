'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { collectDeviceSignals } from '@/lib/deviceSignals';

const LAST_REPORTED_KEY = 'nex-device-signals-reported-at';
// Signals rarely change for a given browser install — screen
// resolution, timezone, and CPU count don't move day to day — so this
// only needs to re-report occasionally (a user's timezone changing on
// travel, say), not on every single page load.
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Mounted once in app/layout.tsx, same as NotificationPrompt/SitePopup.
 * Silently (no visible UI) reports this browser's best-effort
 * hardware/OS signals so an admin reviewing a "New Device Request" can
 * see whether it's likely the SAME physical machine as one they've
 * already approved, just a different browser — see
 * lib/deviceSimilarity.ts and app/api/device/signals/route.ts.
 *
 * Skips /login (no session yet — requireAuthorized() would just reject
 * it) same as NotificationPrompt does. Everything here is best-effort:
 * a failed collect or a failed POST just means this device shows fewer
 * signals to compare against, never a broken sign-in or page load.
 */
export function DeviceSignalCollector() {
  const pathname = usePathname();
  const skip = pathname?.startsWith('/login');

  useEffect(() => {
    if (skip) return;
    if (typeof window === 'undefined') return;

    const lastReported = Number(localStorage.getItem(LAST_REPORTED_KEY) ?? 0);
    if (Date.now() - lastReported < REPORT_INTERVAL_MS) return;

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
        if (res.ok) localStorage.setItem(LAST_REPORTED_KEY, String(Date.now()));
      } catch {
        // Best-effort — see file doc comment above.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skip]);

  return null;
}
