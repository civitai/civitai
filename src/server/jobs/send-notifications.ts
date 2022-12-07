import { createJob } from './job';
import { prisma } from '~/server/db/client';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

const NOTIFICATIONS_LAST_SENT_KEY = 'last-metrics-update';
export const processImportsJob = createJob(
  'send-notifications',
  '*/1 * * * *',
  async () => {
    // Get the last run time from keyValue
    const lastSent = new Date(
      ((
        await prisma.keyValue.findUnique({
          where: { key: NOTIFICATIONS_LAST_SENT_KEY },
        })
      )?.value as number) ?? 0
    );

    // Run all processors in parralel
    const promises = notificationProcessors.map(async ({ run }) => {
      await run({ lastSent });
    });
    await Promise.all(promises);
  },
  {
    shouldWait: false,
  }
);
