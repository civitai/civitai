import { uniq } from 'lodash-es';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { createNotification } from '~/server/services/notification.service';
import { createJob, getJobDate } from './job';

const CUTOFF_DATE = '2024-09-25';

export const sendCollectionNotifications = createJob(
  'send-collection-notifications',
  '*/5 * * * *', // I'd argue every 5 mins is enough for this. We can lower if needed, but I expect this to be fine.
  async () => {
    // This job republishes early access versions that have ended as "New"
    const [lastRun, setLastRun] = await getJobDate(
      'send-collection-notifications',
      new Date(CUTOFF_DATE)
    );

    const updatedCollections = await dbRead.$queryRaw<
      { id: number; name: string; users: number[] }[]
    >`
      SELECT DISTINCT(ci."collectionId") "id", c.name, array_agg(cc."userId") "users" FROM "CollectionItem" ci
      JOIN "Collection" c ON ci."collectionId" = c.id
      JOIN "CollectionContributor" cc ON c.id = cc."collectionId" AND cc."userId" != c."userId"
      WHERE ci."createdAt" >= ${lastRun}
        AND ci."status" = 'ACCEPTED'
        AND c.mode IS DISTINCT FROM 'Contest'
      GROUP BY ci."collectionId", c.name
    `;

    await Promise.all(
      updatedCollections.map(async ({ id, name, users }) => {
        await createNotification({
          userIds: uniq(users),
          type: 'collection-update',
          category: NotificationCategory.Update,
          details: {
            collectionId: id,
            collectionName: name,
          },
          key: `collection-update:${id}`,
          debounceSeconds: 60 * 60, // 1 hour
        }).catch(() => {
          // Do nothing, not too big a deal technically.
        });
      })
    );

    await setLastRun();
  }
);
