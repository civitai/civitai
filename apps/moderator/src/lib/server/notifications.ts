import { createNotificationsClient } from '@civitai/notifications';
import { env } from '$env/dynamic/private';

// Lazy so a missing NOTIFICATIONS_ENDPOINT fails on first use, not at boot.
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
