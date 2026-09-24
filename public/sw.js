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
// `oldSubscription.options` is required, not a nicety: Chrome rejects `subscribe()` without an
// `applicationServerKey`, and a SW has no access to NEXT_PUBLIC_VAPID_PUBLIC_KEY (this file is
// static, served from /public, and never goes through the bundler). The previous
// `?? { userVisibleOnly: true }` fallback therefore could not succeed — it threw straight into the
// catch below. Without the options there is nothing useful to attempt, so bail loudly-ish rather
// than pretend.
//
// `oldEndpoint` is sent so the server can drop the row the push service just rotated away from. It
// would otherwise linger until it accrued 10 consecutive delivery failures (or 180 days of the
// cleanup job), and every one of those sends is wasted work against a dead endpoint.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription?.options;
  if (!options) return;
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
      .catch(() => {})
  );
});
