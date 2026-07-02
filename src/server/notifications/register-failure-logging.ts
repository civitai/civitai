import { setNotificationsFailureLogger } from '@civitai/notifications';
import { logToAxiom } from '~/server/logging/client';

/**
 * Wire EVERY notification-server request failure — across create / bulk / read / count / mark / exists /
 * cleanup — to a SINGLE Axiom event: `name: 'notifications-request-failed'` on the `notifications`
 * datastream. Because the @civitai/notifications client reports through one choke point, this is the one
 * thing to alert/dashboard on when notifications fail to send. Registered once at server startup (see
 * src/instrumentation.node.ts). Idempotent — re-registering just replaces the sink.
 */
export function registerNotificationsFailureLogging() {
  setNotificationsFailureLogger((failure) => {
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
  });
}
