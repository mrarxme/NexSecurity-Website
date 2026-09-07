'use client';

import { useState } from 'react';

/**
 * Copies the current page's URL to the clipboard — "share this class"
 * for students who want to send a classmate straight to this video
 * instead of the board it's nested in.
 */
export function ShareButton() {
  const [copied, setCopied] = useState(false);

  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
    } catch {
      // Clipboard API can be missing entirely (very old browser) or
      // blocked (non-HTTPS context, permission denied) — fall back to
      // the legacy copy trick rather than the button silently doing
      // nothing.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        flashCopied();
      } catch {
        // Truly nothing worked — this is a minor convenience feature,
        // not worth surfacing a scary error over.
      }
    }
  }

  return (
    <button
      onClick={handleShare}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-vault-border px-3 py-1.5 text-xs text-ink-dim transition hover:border-signal hover:text-ink"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-ok">
          <path d="M5 12.5 9.5 17 19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="18" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="6" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="18" cy="19" r="2.4" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8.2 10.8 15.8 6.7M8.2 13.2l7.6 4.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {copied ? 'Copied!' : 'Share'}
    </button>
  );
}
