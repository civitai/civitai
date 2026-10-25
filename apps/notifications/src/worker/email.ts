// Notification-email hand-off, called by the fan-out worker once per fanned PendingNotification row,
// beside dispatchPush and on the same recipient list: users the notification was NEWLY delivered to,
// so a repeated key reaches nobody here either. Rendering, preferences, caps and the send itself live
// in the main app, which holds the processor registry and the mail client.

import { emailNotificationTypes } from '@civitai/notifications/constants';
import { logAxiomError, logToAxiom } from '../lib/server/clients/axiom';
import { mainAppUrl, mainAppWebhookToken } from '../env';
import { emailDispatchTotal } from '../lib/server/metrics';

/** The poll loop awaits this before the next row, so it needs a ceiling like the push render call. */
const SEND_EMAIL_TIMEOUT_MS = 30_000;

export async function dispatchEmail(
  type: string,
  details: Record<string, any>,
  affectedUserIds: number[]
): Promise<void> {
  if (!emailNotificationTypes.includes(type) || affectedUserIds.length === 0) return;
  if (!mainAppUrl || !mainAppWebhookToken) return;
  try {
    const res = await fetch(
      `${mainAppUrl}/api/internal/notifications/send-email?token=${encodeURIComponent(
        mainAppWebhookToken
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, details, userIds: affectedUserIds }),
        signal: AbortSignal.timeout(SEND_EMAIL_TIMEOUT_MS),
      }
    );
    emailDispatchTotal.inc({ outcome: res.ok ? 'dispatched' : 'failure' });
    if (!res.ok)
      logToAxiom({
        type: 'error',
        message: 'notification email endpoint failed',
        data: { status: res.status, notificationType: type },
      }).catch(() => null);
  } catch (e) {
    emailDispatchTotal.inc({ outcome: 'failure' });
    logAxiomError(e as Error);
  }
}
