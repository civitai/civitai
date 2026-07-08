import { createNotificationsClient } from '@civitai/notifications';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

// The monolith's single notifications client. Every request failure routes to one Axiom event
// (`notifications-request-failed`, datastream `notifications`) — the single signal to alert on. Import
// this instance; there should be exactly one configured client.
export const notifications = createNotificationsClient({
  endpoint: env.NOTIFICATIONS_ENDPOINT,
  token: env.NOTIFICATIONS_TOKEN,
  onFailure: (failure) => {
    logToAxiom(
      {
        type: 'error',
        name: 'notifications-request-failed',
        path: failure.path,
        status: failure.status,
        retryable: failure.retryable,
        attempts: failure.attempts,
        message: failure.message,
      },
      'notifications'
    ).catch(() => {});
  },
});
