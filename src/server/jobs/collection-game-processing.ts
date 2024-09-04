import { createNotification } from '~/server/services/notification.service';
import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { NotificationCategory } from '~/server/common/enums';

export const collectionGameProcessing = createJob(
  'collection-game-processing',
  '0 * * * *',
  async () => {
    await buzzBeggarsBoard();
  }
);

const BEGGARS_BOARD_ID = 3870938;
const BEGGARS_BOARD_DURATION = '3 days';
async function buzzBeggarsBoard() {
  const processingTime = Date.now();
  // Remove rejected items so that new items can be added
  const rejected = await dbWrite.$queryRaw<Row[]>`
    DELETE
    FROM "CollectionItem" ci
    WHERE "collectionId" = ${BEGGARS_BOARD_ID}
      AND status = 'REJECTED'
    RETURNING id, "addedById";
  `;
  const rejectedUsers = new Set(rejected.map((r) => r.addedById));
  console.log('rejectedUsers', rejectedUsers);

  // Remove things that have been on the board for too long
  const expired = await dbWrite.$queryRaw<Row[]>`
    DELETE
    FROM "CollectionItem" ci
    WHERE "collectionId" = ${BEGGARS_BOARD_ID}
      AND status = 'ACCEPTED'
      AND now() - "reviewedAt" > ${BEGGARS_BOARD_DURATION}::interval
    RETURNING id, "addedById";
  `;
  const expiredUsers = new Set(expired.map((r) => r.addedById));
  console.log('expiredUsers', expiredUsers);

  await createNotification({
    type: 'beggars-board-rejected',
    category: NotificationCategory.Buzz,
    key: `beggars-board-rejected:${processingTime}`,
    userIds: [...rejectedUsers],
    details: {},
  });
  await createNotification({
    type: 'beggars-board-expired',
    category: NotificationCategory.Buzz,
    key: `beggars-board-expired:${processingTime}`,
    userIds: [...expiredUsers],
    details: {},
  });
}

type Row = {
  id: number;
  addedById: number;
};
