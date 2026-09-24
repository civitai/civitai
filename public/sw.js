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
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription?.options ?? { userVisibleOnly: true })
      .then((subscription) =>
        fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        })
      )
      .catch(() => {})
  );
});
