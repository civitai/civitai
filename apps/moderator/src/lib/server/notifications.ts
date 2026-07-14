import { createNotificationsClient } from '@civitai/notifications';
import { env } from '$env/dynamic/private';

// HTTP client to the notifications app (apps/notifications), same seam the monolith uses — no notification
// DB access, mirror of the syncSearchIndex boundary. Lazy so a missing NOTIFICATIONS_ENDPOINT fails on
// first use (best-effort at the call site), not at boot. Every final request failure logs once.
let client: ReturnType<typeof createNotificationsClient> | undefined;

export function getNotifications(): ReturnType<typeof createNotificationsClient> {
  if (!client)
    client = createNotificationsClient({
      endpoint: env.NOTIFICATIONS_ENDPOINT,
      token: env.NOTIFICATIONS_TOKEN,
      onFailure: (failure) =>
        console.error('notifications-request-failed', {
          path: failure.path,
          status: failure.status,
          message: failure.message,
        }),
    });
  return client;
}
