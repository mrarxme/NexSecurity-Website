'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getPushStatus, subscribeToPush } from '@/lib/webPushClient';

const DISMISS_KEY = 'nex-push-dismissed';

/**
 * Mounted once in app/layout.tsx, same as SitePopup — skips /admin and
 * /login for the same reasons. Deliberately never auto-prompts:
 * browsers increasingly punish sites that ask for notification
 * permission without a clear, deliberate click (Chrome can silently
 * downgrade the prompt to a quiet, easy-to-miss UI for repeat offenders)
 * — so this only ever shows a dismissible banner and waits for an
 * actual click before calling Notification.requestPermission().
 *
 * This is only the FIRST-RUN nudge, and it can legitimately never
 * appear again after one dismiss/decision — that's fine, because it's
 * not the only way to enable push anymore. The bell dropdown in
 * components/TopNav.tsx has its own persistent "Enable notifications"
 * control for anyone who dismissed this, changed their mind later, or
 * whose browser doesn't support push at all (in which case TopNav
 * explains that plainly instead of just having nothing to click).
 */
export function NotificationPrompt() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const skip = pathname?.startsWith('/admin') || pathname === '/login';

  useEffect(() => {
    if (skip) return;
    if (getPushStatus() !== 'default') return; // unsupported, or already decided either way
    if (localStorage.getItem(DISMISS_KEY)) return;
    setVisible(true);
  }, [skip]);

  async function enable() {
    setBusy(true);
    const result = await subscribeToPush();
    if (!result.ok) localStorage.setItem(DISMISS_KEY, '1');
    setBusy(false);
    setVisible(false);
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 rounded-xl border border-vault-border bg-vault-900 p-4 shadow-glass backdrop-blur-xl sm:left-auto sm:right-4 sm:translate-x-0">
      <p className="text-sm text-ink">Get notified the moment a new class goes up?</p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={dismiss}
          className="rounded-md border border-vault-border px-3 py-1.5 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
        >
          Not now
        </button>
        <button
          onClick={enable}
          disabled={busy}
          className="rounded-md bg-signal px-3 py-1.5 text-xs font-medium text-white transition hover:bg-signal-glow disabled:opacity-60"
        >
          {busy ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
