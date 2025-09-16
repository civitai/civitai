import dayjs from '~/shared/utils/dayjs';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

// const ALERT_VOLUME = 1000;
// const ALERT_PERIOD = 5; //Minutes
export const moderatorWebhooks = createWebhookProcessor({
  'download-volume': {
    displayName: 'Download Volume Alerts',
    moderatorOnly: true,
    getData: async ({ prisma }) => {
      return [];

      // const end = new Date();
      // const start = dayjs(end).add(-ALERT_PERIOD, 'minutes').toDate();
      // const downloadCount = await prisma.userActivity.count({
      //   where: { createdAt: { gte: start } },
      // });

      // if (downloadCount < ALERT_VOLUME) return [];

      // return [{ downloadCount, end, start }];
    },
  },
});
