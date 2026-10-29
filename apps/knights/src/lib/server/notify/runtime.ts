import { createNotificationsClient } from '@civitai/notifications';
import { env } from '$env/dynamic/private';
import type { SendBatch } from './notify.service';

// Lazy so a missing NOTIFICATIONS_ENDPOINT fails on the first send, not at boot.
let client: ReturnType<typeof createNotificationsClient> | undefined;

function notifications() {
  client ??= createNotificationsClient({
    endpoint: env.NOTIFICATIONS_ENDPOINT,
    token: env.NOTIFICATIONS_TOKEN,
    onFailure: (failure) =>
      console.error('knights: notifications-request-failed', {
        path: failure.path,
        status: failure.status,
        message: failure.message,
      }),
  });
  return client;
}

/**
 * The bulk path skips the notification settings filter; that is what an opt-in type needs, because
 * the sender has already limited the batch to players who subscribed.
 */
export const sendBatch: SendBatch = (batch) =>
  notifications().createNotificationsBulk([
    {
      key: batch.key,
      type: batch.type,
      category: 'Other',
      users: batch.userIds,
      details: {},
    },
  ]);
