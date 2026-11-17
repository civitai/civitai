// Service worker: web push, an offline fallback page, and a cache for hashed static assets.
//
// What it must never do: cache page HTML, tRPC/API responses, feeds or image-CDN data (all go to the
// network untouched), or run a non-GET, cross-origin or /api/ request through respondWith (downloads
// need Range/streaming). A buggy copy of this file keeps running in browsers after the fix ships.
//
// KILL SWITCH: ship a sw.js with no `fetch` listener whose `activate` deletes every cache and calls
// `self.registration.unregister()`. Browsers re-check this file on navigation (at most every 24h) and
// skip the HTTP cache for it, so it reaches clients without a cache purge. To retire only the caches,
// bump VERSION: `activate` deletes every cache not named for the current version.
//
// Do not enable navigationPreload: it is per registration, so the browser would also preload the
// /api/ and non-HTML navigations this worker declines, then re-request them, hitting the server twice.

const VERSION = 'v1';
const SHELL_CACHE = `civitai-shell-${VERSION}`;
const STATIC_CACHE = `civitai-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const STATIC_PREFIX = '/_next/static/';
const STATIC_MAX_ENTRIES = 200;

self.addEventListener('install', (event) => {
  // Never fails the install: push opt-in waits on this worker becoming ready, so a missing offline
  // page (network blip, region redirect) only costs the fallback, not push.
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch(OFFLINE_URL, { cache: 'reload' });
        if (response.ok && !response.redirected) {
          await (await caches.open(SHELL_CACHE)).put(OFFLINE_URL, response);
        }
      } catch {
        // fall through: no offline page cached
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, STATIC_CACHE];
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.includes(name)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (url.pathname.startsWith('/api/')) return;
    if (!(request.headers.get('accept') || '').includes('text/html')) return;
    event.respondWith(networkFirstWithOfflineFallback(event));
    return;
  }

  if (url.pathname.startsWith(STATIC_PREFIX) && !request.headers.has('range')) {
    event.respondWith(cacheFirstStatic(event));
  }
});

// Only a thrown fetch (no network) shows the fallback. Any HTTP response, including 5xx, is the
// server's answer and passes through. No timeout: slow is not offline.
async function networkFirstWithOfflineFallback(event) {
  try {
    return await fetch(event.request);
  } catch {
    const cached = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    return cached || Response.error();
  }
}

// Safe to cache forever: Next content-hashes these file names. A cache fault falls through to the
// network, since a rejection here would block the file for good.
async function cacheFirstStatic(event) {
  let cache = null;
  try {
    cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
  } catch {
    cache = null;
  }
  const response = await fetch(event.request);
  if (cache && isCacheableAsset(response)) {
    event.waitUntil(
      cache
        .put(event.request, response.clone())
        .then(() => trimCache(cache, STATIC_MAX_ENTRIES))
        .catch(() => undefined)
    );
  }
  return response;
}

// A captive portal or proxy can answer a chunk URL with a 200 login page; never pin that.
function isCacheableAsset(response) {
  return (
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected &&
    !(response.headers.get('content-type') || '').includes('text/html')
  );
}

// cache.keys() is in insertion order, so this drops the oldest entries first.
async function trimCache(cache, max) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  const { title, body, url } = payload;
  if (!title || !body) return;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/images/android-chrome-192x192.png',
      badge: '/images/android-chrome-192x192.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/user/notifications';
  const absolute = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === absolute && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(absolute);
    })
  );
});

// The push service can rotate the subscription; re-subscribe and tell the server, or pushes go
// to an endpoint nobody holds anymore.
//
// Prefer `oldSubscription.options` — it carries the `applicationServerKey`, which a SW cannot get
// any other way (this file is static, served from /public, and never goes through the bundler, so
// NEXT_PUBLIC_VAPID_PUBLIC_KEY is not substituted into it).
//
// The `{ userVisibleOnly: true }` fallback is kept because it is NOT universally dead, only dead on
// Chromium: Chrome rejects a keyless `subscribe()` (there is no `gcm_sender_id` anywhere in this
// app, so the legacy escape hatch does not apply), but Gecko permits one, and Gecko is also the
// engine most likely to fire this event without populating `oldSubscription`. Dropping the fallback
// would therefore have ended push on exactly the browsers it still works on. On Chromium it throws
// into the catch below, which costs nothing and is what already happened.
//
// `oldEndpoint` is sent so the server can drop the row the push service rotated away from. The cost
// of NOT reaping it is one wasted send, not ten — a rotated endpoint answers 410 Gone, which the
// dispatcher already treats as delete-on-first-failure; the 10-failure ceiling is the 5xx path. The
// reason to reap it is user-visible: until that next send, `getPushSubscriptions` returns BOTH rows,
// so the device list shows two entries for one browser.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription?.options ?? { userVisibleOnly: true };
  const oldEndpoint = event.oldSubscription?.endpoint ?? null;
  event.waitUntil(
    self.registration.pushManager
      .subscribe(options)
      .then((subscription) =>
        fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...subscription.toJSON(), oldEndpoint }),
        })
      )
      // Nothing actionable is available here — no app context, no logger, and a rotation we could
      // not service simply means this browser stops receiving push until it next loads settings and
      // reconciles. Kept quiet rather than console-noisy on every Chromium rotation that had no
      // options to use.
      .catch(() => {})
  );
});
