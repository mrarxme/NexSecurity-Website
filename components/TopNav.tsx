'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { SearchInput } from '@/components/SearchInput';
import { relativeTime } from '@/lib/relativeTime';

type NavItem = { href: string; label: string; icon: JSX.Element; match: (path: string) => boolean };
type SearchResult =
  | { type: 'board'; id: string; title: string; board_type: 'normal' | 'routine'; published: boolean }
  | { type: 'class'; id: string; title: string; published: boolean };
type PendingRequest = {
  id: string;
  device_id: string;
  ip_address: string;
  device_label: string;
  first_seen: string;
  user_id: string | null;
  user_email: string;
};

// A background tab has its timers throttled by the browser, so a fixed
// setInterval here tends to land on the exact same tick as other polling
// intervals elsewhere in the app (e.g. VideoPlayer's heartbeat/progress
// checkpoint) — all becoming "due" at once and firing in one burst the
// moment the user switches back to this tab. That burst was landing
// several concurrent session-refresh attempts on the server simultaneously
// (see lib/supabase/middleware.ts for the actual fix for that). Using a
// recursive setTimeout with a randomized ±20% delay instead just spreads
// this poll's ticks away from everyone else's instead of staying
// phase-locked with them.
function jitteredPoll(callback: () => void, baseMs: number): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const jitter = baseMs * 0.2 * (Math.random() * 2 - 1);
    timeoutId = setTimeout(() => {
      if (cancelled) return;
      callback();
      if (!cancelled) schedule();
    }, Math.max(1000, baseMs + jitter));
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timeoutId);
  };
}

const ICONS = {
  home: (
    <path
      d="M4 11.5 12 4l8 7.5M6 9.5V20h12V9.5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  learn: (
    <path
      d="m12 4 9 4-9 4-9-4 9-4Zm-6 6.2V16c0 1.1 2.7 3 6 3s6-1.9 6-3v-5.8"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  ebook: (
    <path
      d="M4 5.5C5.2 4.9 7 4.5 9 4.5c1.7 0 3.3.3 4 .8v13.2c-.7-.5-2.3-.8-4-.8-2 0-3.8.4-5 1V5.5Zm18 0c-1.2-.6-3-1-5-1-1.7 0-3.3.3-4 .8v13.2c.7-.5 2.3-.8 4-.8 2 0 3.8.4 5 1V5.5Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  routine: (
    <path
      d="M7 3v3.5M17 3v3.5M4 9.5h16M5.5 5.5h13a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V7a1.5 1.5 0 0 1 1.5-1.5Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  admin: (
    <path
      d="M12 3.5 5 6v5.4c0 4.4 2.9 7.7 7 9.1 4.1-1.4 7-4.7 7-9.1V6l-7-2.5Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  downloads: (
    <path
      d="M12 3.5v11m0 0-3.8-3.8M12 14.5l3.8-3.8M5 17v1.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V17"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
};

export function TopNav({
  email,
  isAdmin,
  profile,
}: {
  email: string;
  isAdmin: boolean;
  /** Google profile photo/name (from lib/auth.ts's getAuth(), which
   * already has the Supabase Auth user object in hand server-side) —
   * passed down instead of re-fetched client-side, so the real avatar
   * renders on the very first paint instead of popping in after an
   * extra round trip. Optional/nullable for any caller that hasn't been
   * updated to pass it yet; falls back to the email-derived name below. */
  profile?: { avatarUrl: string | null; fullName: string | null } | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const googleProfile = profile ?? null;

  const [notifOpen, setNotifOpen] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const notifRef = useRef<HTMLDivElement>(null);

  const items: NavItem[] = [
    { href: '/', label: 'Home', icon: ICONS.home, match: (p) => p === '/' },
    {
      href: '/learn',
      label: 'Learn',
      icon: ICONS.learn,
      match: (p) => p === '/learn' || p.startsWith('/learn/board') || p.startsWith('/learn/video'),
    },
    { href: '/learn/ebooks', label: 'E-Book', icon: ICONS.ebook, match: (p) => p.startsWith('/learn/ebooks') },
    {
      href: '/learn/routines',
      label: 'Routine',
      icon: ICONS.routine,
      match: (p) => p.startsWith('/learn/routines'),
    },
    {
      href: '/learn/downloads',
      label: 'Downloads',
      icon: ICONS.downloads,
      match: (p) => p.startsWith('/learn/downloads'),
    },
    ...(isAdmin
      ? [{ href: '/admin', label: 'Admin', icon: ICONS.admin, match: (p: string) => p.startsWith('/admin') }]
      : []),
  ];

  const activeHref = items.find((i) => i.match(pathname))?.href ?? items[0].href;

  // Close the mobile nav sheet automatically whenever navigation happens.
  useEffect(() => {
    setMobileNavOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  // Ctrl/Cmd+K opens the search palette from anywhere; Escape closes it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Autofocus the input the moment the palette opens.
  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery('');
      setSearchResults([]);
    }
  }, [searchOpen]);

  // Debounced search — a class/board list that's grown large is exactly
  // what this box is for, so results update as you type rather than
  // requiring a submit.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/learn/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setSearchResults(res.ok ? data.results ?? [] : []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  function goToResult(result: SearchResult) {
    setSearchOpen(false);
    router.push(result.type === 'class' ? `/learn/video/${result.id}` : `/learn/board/${result.id}`);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      // composedPath handles clicks that originate inside portaled/shadow
      // content more reliably than a plain .contains() check.
      const path = 'composedPath' in e ? (e as MouseEvent).composedPath() : [];
      const inside = path.length ? path.includes(menuRef.current as EventTarget) : !!menuRef.current?.contains(target);
      if (!inside) setMenuOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    // Listener is only attached while the menu is open, and only after this
    // tick — otherwise the same click that just opened the menu (mousedown
    // fires before the button's own click handler resolves) can be seen as
    // an "outside" click on some browsers and immediately close it again.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('touchstart', onPointerDown);
      document.addEventListener('keydown', onEscape);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menuOpen]);

  // Polls for pending device sign-in requests — admin-only, since only
  // admins can even reach /api/admin/requests. Deliberately a short
  // interval poll rather than a live Postgres-changes subscription: it's
  // far simpler to reason about correctly (no separate Realtime/RLS
  // wiring to get right on a security-sensitive table), and ~15s is
  // already fast enough for a human to notice and act on.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/admin/requests');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPendingRequests(data.requests ?? []);
      } catch {
        // Silent — a missed poll just means the badge is stale for one
        // cycle, not worth surfacing as an error to the admin.
      }
    }
    poll();
    const stop = jitteredPoll(poll, 15_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!notifOpen) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      const path = 'composedPath' in e ? (e as MouseEvent).composedPath() : [];
      const inside = path.length ? path.includes(notifRef.current as EventTarget) : !!notifRef.current?.contains(target);
      if (!inside) setNotifOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setNotifOpen(false);
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointerDown);
      document.addEventListener('touchstart', onPointerDown);
      document.addEventListener('keydown', onEscape);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [notifOpen]);

  function goToRequest(id: string) {
    setNotifOpen(false);
    router.push(`/admin/requests?highlight=${id}`);
  }

  async function handleLogout() {
    setLoggingOut(true);
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut({ scope: 'local' });
    router.push('/login');
    router.refresh();
  }

  // Prefer the real Google name; fall back to one derived from the email's
  // local part (e.g. "arabi.islam" -> "Arabi Islam") if metadata hasn't
  // loaded yet or isn't present.
  const displayName =
    googleProfile?.fullName ||
    email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  return (
    <header className="sticky top-0 z-30 px-4 pt-3">
      <div className="glass-panel-solid mx-auto max-w-screen-2xl rounded-2xl">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6 md:gap-6">
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="relative h-8 w-8 overflow-hidden rounded-lg border border-vault-border bg-vault-800 shadow-glass">
              <Image src="/logo.png" alt="NexSecurity" fill className="object-cover" />
            </span>
            <span className="hidden font-display text-sm font-semibold tracking-tight text-ink sm:inline">NexSecurity</span>
          </Link>
        </div>

        <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar md:flex">
          {items.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition lg:px-3 ${
                  active ? 'bg-signal/10 text-signal' : 'text-ink-dim hover:bg-vault-600 hover:text-ink'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0" aria-hidden="true">
                  {item.icon}
                </svg>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <button
          onClick={() => setSearchOpen(true)}
          aria-label="Search classes and boards"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-dim transition hover:bg-vault-600 hover:text-ink lg:hidden"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        <button
          onClick={() => setMobileNavOpen((v) => !v)}
          aria-label="Toggle navigation menu"
          aria-expanded={mobileNavOpen}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-dim transition hover:bg-vault-600 hover:text-ink md:hidden"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {mobileNavOpen ? (
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            )}
          </svg>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
          <button
            onClick={() => setSearchOpen(true)}
            className="hidden min-w-0 items-center gap-2 rounded-lg border border-vault-border bg-vault-800/60 px-3 py-2 text-ink-faint transition hover:border-signal/50 lg:flex"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-left text-xs">Search classes, boards…</span>
            <kbd className="ml-4 shrink-0 whitespace-nowrap rounded border border-vault-border bg-vault-600 px-1.5 py-0.5 text-[10px] font-medium">
              Ctrl K
            </kbd>
          </button>

          <div className="relative" ref={notifRef}>
            <button
              onClick={() => isAdmin && setNotifOpen((v) => !v)}
              title={isAdmin ? 'Device sign-in requests' : 'Notifications'}
              className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition hover:bg-vault-600 hover:text-ink"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 9a6 6 0 1 1 12 0c0 4.2 1 5.5 1.5 6.2.3.4 0 .8-.5.8H5c-.5 0-.8-.4-.5-.8C5 14.5 6 13.2 6 9Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              {isAdmin && pendingRequests.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
                  {pendingRequests.length > 9 ? '9+' : pendingRequests.length}
                </span>
              )}
            </button>

            {isAdmin && notifOpen && (
              <div className="glass-panel-solid absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-xl py-1">
                <p className="px-3.5 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                  Device sign-in requests
                </p>
                {pendingRequests.length === 0 ? (
                  <p className="px-3.5 py-4 text-center text-xs text-ink-faint">
                    No pending requests right now.
                  </p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto">
                    {pendingRequests.slice(0, 5).map((req) => (
                      <li key={req.id}>
                        <button
                          onClick={() => goToRequest(req.id)}
                          className="flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition hover:bg-vault-600"
                        >
                          <span className="truncate text-sm text-ink">{req.user_email}</span>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                            {req.device_label} · {relativeTime(req.first_seen)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <Link
                  href="/admin/requests"
                  onClick={() => setNotifOpen(false)}
                  className="block border-t border-vault-border px-3.5 py-2.5 text-center text-xs font-medium text-signal transition hover:bg-vault-600"
                >
                  View all requests
                </Link>
              </div>
            )}
          </div>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition hover:bg-vault-600"
            >
              {googleProfile?.avatarUrl ? (
                // Google-hosted avatar (lh3.googleusercontent.com etc) — a
                // plain <img> rather than next/image since the host isn't
                // (and shouldn't need to be) in next.config.js's image
                // allowlist for a single small profile picture.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={googleProfile.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full border border-vault-border object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-signal/15 text-xs font-semibold text-signal">
                  {initials || '?'}
                </span>
              )}
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-xs font-semibold text-ink">{displayName}</span>
                <span className="block text-[11px] text-ink-faint">{isAdmin ? 'Admin' : 'Member'}</span>
              </span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="hidden text-ink-faint sm:block"
              >
                <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {menuOpen && (
              <div className="glass-panel-solid absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl py-1">
                <p className="truncate px-3.5 py-2 text-xs text-ink-faint" title={email}>
                  {email}
                </p>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm text-ink-dim transition hover:bg-vault-600 hover:text-danger disabled:opacity-60"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {loggingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        </div>
        </div>

        {mobileNavOpen && (
          <nav className="rounded-b-2xl border-t border-vault-border/70 px-3 py-2 md:hidden">
            {items.map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                    active ? 'bg-signal/10 text-signal' : 'text-ink-dim hover:bg-vault-600 hover:text-ink'
                  }`}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    {item.icon}
                  </svg>
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      {searchOpen && (
        <div
          className="fixed inset-0 z-40 flex justify-center bg-black/40 px-4 pt-24 backdrop-blur-sm"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="glass-panel-solid h-fit w-full max-w-lg rounded-2xl p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search classes and boards…"
              autoFocus
            />
            <div className="mt-2 max-h-80 overflow-y-auto">
              {searchQuery.trim().length < 2 ? (
                <p className="px-2 py-6 text-center text-xs text-ink-faint">
                  Keep typing to search across every board and class.
                </p>
              ) : searchLoading ? (
                <p className="px-2 py-6 text-center text-xs text-ink-faint">Searching…</p>
              ) : searchResults.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-ink-faint">
                  No boards or classes match &ldquo;{searchQuery}&rdquo;.
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {searchResults.map((r) => (
                    <li key={`${r.type}-${r.id}`}>
                      <button
                        onClick={() => goToResult(r)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-ink transition hover:bg-vault-600"
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          className="shrink-0 text-ink-faint"
                          aria-hidden="true"
                        >
                          {r.type === 'class' ? (
                            <path
                              d="M6 4h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm8 0v4h4M9.5 11l5 3-5 3v-6Z"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          ) : (
                            <path
                              d="m12 3 8 4-8 4-8-4 8-4Zm-8 8 8 4 8-4"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                        </svg>
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        <span className="flex shrink-0 gap-1.5">
                          {r.type === 'board' && r.board_type === 'routine' && (
                            <span className="rounded-full border border-vault-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                              Routine
                            </span>
                          )}
                          {!r.published && (
                            <span className="rounded-full border border-warn/30 bg-warn/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-warn">
                              Draft
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
