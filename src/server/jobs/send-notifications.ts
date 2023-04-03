import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { notificationBatches } from '~/server/notifications/utils.notifications';
import { createLogger } from '~/utils/logging';

const log = createLogger('send-notifications', 'blue');

const NOTIFICATIONS_LAST_SENT_KEY = 'last-sent-notifications';
export const sendNotificationsJob = createJob('send-notifications', '*/1 * * * *', async () => {
  try {
    // Get the last run time from keyValue
    const lastSent = new Date(
      ((
        await dbWrite.keyValue.findUnique({
          where: { key: NOTIFICATIONS_LAST_SENT_KEY },
        })
      )?.value as number) ?? 0
    ).toISOString();

    // Run all processors in batches by priority
    // --------------------------------------------
    // Prepare batches

    // Run batches
    for (const batch of notificationBatches) {
      const promises = batch.map(async ({ prepareQuery }) => {
        const query = await prepareQuery?.({ lastSent });
        if (query) await dbWrite.$executeRawUnsafe(query);
      });
      await Promise.all(promises);
    }
    log('sent notifications');

    // Update the last sent time
    // --------------------------------------------
    await dbWrite?.keyValue.upsert({
      where: { key: NOTIFICATIONS_LAST_SENT_KEY },
      create: { key: NOTIFICATIONS_LAST_SENT_KEY, value: new Date().getTime() },
      update: { value: new Date().getTime() },
    });
  } catch {
    log('failed to send notifications');
  }
});
