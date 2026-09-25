// Web-push-only service worker. Deliberately has NO fetch handler — a caching SW on a Next.js app
// can serve stale HTML/JS to every visitor and a broken one keeps running after the fix ships.
// Do not expand this file's job beyond push.

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
