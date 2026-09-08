'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

const DISMISS_KEY = 'nex-push-dismissed';

// PushManager wants the VAPID public key as a raw Uint8Array, not the
// base64url string it's normally handed around as everywhere else.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * Mounted once in app/layout.tsx, same as SitePopup — skips /admin and
 * /login for the same reasons. Deliberately never auto-prompts:
 * browsers increasingly punish sites that ask for notification
 * permission without a clear, deliberate click (Chrome can silently
 * downgrade the prompt to a quiet, easy-to-miss UI for repeat offenders)
 * — so this only ever shows a dismissible banner and waits for an
 * actual click before calling Notification.requestPermission().
 */
export function NotificationPrompt() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const skip = pathname?.startsWith('/admin') || pathname === '/login';

  useEffect(() => {
    if (skip) return;
    if (typeof window === 'undefined') return;
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'default') return; // already decided, either way — nothing to ask
    if (localStorage.getItem(DISMISS_KEY)) return;
    setVisible(true);
  }, [skip]);

  async function enable() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        localStorage.setItem(DISMISS_KEY, '1');
        setVisible(false);
        return;
      }
      const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!publicKey) {
        setVisible(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast needed because TS's DOM lib types Uint8Array as backed by
        // the more general ArrayBufferLike (which also covers
        // SharedArrayBuffer) while BufferSource wants a plain
        // ArrayBuffer specifically — Uint8Array.from() below always
        // allocates a normal ArrayBuffer at runtime, so this is safe.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
    } catch {
      // Best-effort — a failed subscribe just means this device won't
      // get push notifications, not worth surfacing an error over.
    }
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
