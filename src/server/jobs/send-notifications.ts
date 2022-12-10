import { createJob } from './job';
import { prisma } from '~/server/db/client';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

const NOTIFICATIONS_LAST_SENT_KEY = 'last-sent-notifications';
export const sendNotificationsJob = createJob(
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
    ).toISOString();

    // Run all processors in parralel
    const promises = Object.values(notificationProcessors).map(async ({ prepareQuery }) => {
      const query = await prepareQuery?.({ lastSent });
      if (query) await prisma.$executeRawUnsafe(query);
    });
    await Promise.all(promises);
    console.log('sent notifications');

    // Update the last sent time
    // --------------------------------------------
    await prisma?.keyValue.upsert({
      where: { key: NOTIFICATIONS_LAST_SENT_KEY },
      create: { key: NOTIFICATIONS_LAST_SENT_KEY, value: new Date().getTime() },
      update: { value: new Date().getTime() },
    });
  },
  {
    shouldWait: false,
  }
);
