// Deliberately minimal — and deliberately NOT caching anything. This
// site is a private, always-online, frequently-updated learning space
// (auth-gated, DB-backed, video player fixed and redeployed often) — a
// service worker that caches its own shell is exactly the kind of thing
// that leaves a browser stuck running yesterday's JS against today's
// API until someone thinks to hard-refresh or clear site data. The ONLY
// reason this file exists is that Chrome/Edge's "installable as an app"
// criteria requires an active service worker with a fetch handler, which
// is what makes the PWA install prompt on /learn/downloads available.
// Every request — including this file's own updates — is served
// straight from cache-control headers instead (see next.config.js),
// never from here.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Also sweeps away any cache this worker created in an earlier
      // version, before this file was simplified to not cache at all.
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', () => {
  // Deliberately does NOT call event.respondWith(). Chrome/Edge's
  // installability check only requires a registered fetch handler to
  // exist — it never requires that handler to actually respond.
  //
  // The previous version of this file called
  // `event.respondWith(fetch(event.request))`, thinking that was a safe
  // transparent passthrough. It was not: a fetch() issued FROM INSIDE a
  // service worker is subject to the page's `connect-src` CSP directive,
  // not whatever directive (img-src, script-src, frame-src) the request
  // would normally fall under. That silently broke the YouTube player
  // script, profile picture loads, and occasionally navigation itself —
  // exactly the "video won't play until I clear site data" bug. Not
  // calling respondWith() at all means the browser handles every request
  // completely natively, as if this service worker weren't intercepting
  // it — which is the actual correct behavior for a worker that exists
  // only to satisfy PWA installability, not to do anything with traffic.
});

// --- Web Push: new-class notifications -------------------------------
// The only other job this worker does. A push message arrives here
// (from app/api/admin/videos's notifyNewClass, via lib/webPush.ts) as a
// plain JSON payload — this just displays it as a system notification;
// it never touches the cache/fetch behavior above.
self.addEventListener('push', (event) => {
  let payload = { title: 'NexSecurity', body: '', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Not JSON for some reason — fall back to plain text rather than
    // dropping the notification entirely.
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url || '/' },
    })
  );
});

// Clicking the notification focuses an already-open tab on that class
// if one exists, instead of always opening a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => new URL(c.url).pathname === url);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
