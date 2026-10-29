import {
  createNotificationsBulkInput,
  type CreateNotificationRow,
  type NotificationsClientConfig,
} from '@civitai/notifications';
import { BatchRejected, type SendBatch } from './notify.service';
import { isDefinitiveRejection } from './rejection';

/**
 * No retries inside the client: it would report only the last error of several attempts, and a
 * timeout followed by a 429 must stay "unknown". A retry is the job's own, under its claim rules.
 */
export const clientConfig = (
  env: Record<string, string | undefined>
): NotificationsClientConfig => ({
  endpoint: env.NOTIFICATIONS_ENDPOINT,
  token: env.NOTIFICATIONS_TOKEN,
  retries: 0,
  onFailure: (failure) =>
    console.error('knights: notifications-request-failed', {
      path: failure.path,
      status: failure.status,
      message: failure.message,
    }),
});

/** Validates the payload itself, so a schema failure is known to precede any send. */
export const makeSendBatch =
  (post: (rows: CreateNotificationRow[]) => Promise<void>): SendBatch =>
  async (batch) => {
    let rows: CreateNotificationRow[];
    try {
      rows = createNotificationsBulkInput.parse([
        {
          key: batch.key,
          type: batch.type,
          category: 'Other',
          users: batch.userIds,
          details: {},
        },
      ]);
    } catch (error) {
      throw new BatchRejected('invalid notification payload', { cause: error });
    }
    try {
      await post(rows);
    } catch (error) {
      if (isDefinitiveRejection(error))
        throw new BatchRejected('batch not accepted', { cause: error });
      throw error;
    }
  };
