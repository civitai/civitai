// Hands newly delivered recipients to the main app, which holds the processor registry,
// preferences, caps and the mail client.

import { chunk } from 'lodash-es';
import { emailNotificationTypes } from '@civitai/notifications/constants';
import { logAxiomError, logToAxiom } from '../lib/server/clients/axiom';
import { mainAppUrl, mainAppWebhookToken } from '../env';
import { emailDispatchTotal } from '../lib/server/metrics';

/** Node fetch has no default timeout and the poll loop awaits this call. */
const SEND_EMAIL_TIMEOUT_MS = 30_000;
/** The endpoint's `userIds` ceiling. */
const USERS_PER_REQUEST = 1000;

export async function dispatchEmail(
  type: string,
  details: Record<string, any>,
  affectedUserIds: number[]
): Promise<void> {
  if (!emailNotificationTypes.includes(type) || affectedUserIds.length === 0) return;
  if (!mainAppUrl || !mainAppWebhookToken) return;
  for (const userIds of chunk(affectedUserIds, USERS_PER_REQUEST)) {
    try {
      const res = await fetch(
        `${mainAppUrl}/api/internal/notifications/send-email?token=${encodeURIComponent(
          mainAppWebhookToken
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, details, userIds }),
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
}
