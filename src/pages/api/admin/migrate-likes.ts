import dayjs from 'dayjs';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { eventEngine } from '~/server/events';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { getTopContributors } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const batchSize = 10000;
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
    SELECT MAX("userId") as "maxCursor"
    FROM "ModelEngagement"
    WHERE type = 'Favorite';
  `);
  res.on('close', maxCursorQuery.cancel);
  const [{ maxCursor }] = await maxCursorQuery.result();
  console.log('Migrating likes:', maxCursor);

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  let cursor = 0;
  await limitConcurrency(() => {
    if (stop || cursor > maxCursor) return null;

    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);

    return async () => {
      console.log('Migrating likes:', start, ' - ', end);
      const moveToBookmarksQuery = await pgDbWrite.cancellableQuery(`
        WITH liked_collections AS (
          INSERT INTO "Collection" ("userId", "name", "description", "type", "availability", "mode")
          SELECT DISTINCT
            me."userId",
            'Favorite Models' "name",
            'Your liked models will appear in this collection.',
            'Model'::"CollectionType" "type",
            'Unsearchable'::"Availability" "availability",
            'Bookmark'::"CollectionMode"
          FROM "ModelEngagement" me
          WHERE "userId" > ${start} AND "userId" <= ${end} AND type = 'Favorite'
          AND NOT EXISTS (
            SELECT 1
            FROM "Collection"
            WHERE "userId" = me."userId"
            AND "type" = 'Model'
            AND "mode" = 'Bookmark'
          )
          ON CONFLICT DO NOTHING
          RETURNING "id", "userId"
        )
        INSERT INTO "CollectionItem" ("collectionId", "modelId", "note", "createdAt")
        SELECT
          c.id,
          e."modelId",
          'Migrated from old likes',
          e."createdAt"
        FROM liked_collections c
        JOIN "ModelEngagement" e ON e."userId" = c."userId"
        WHERE e.type = 'Favorite'
      `);
      cancelFns.push(moveToBookmarksQuery.cancel);
      await moveToBookmarksQuery.result();

      const createNotifyQuery = await pgDbWrite.cancellableQuery(`
        INSERT INTO "ModelEngagement" ("userId", "modelId", "type", "createdAt")
        SELECT
          "userId",
          "modelId",
          'Notify',
          "createdAt"
        FROM "ModelEngagement"
        WHERE "userId" > ${start} AND "userId" <= ${end} AND type = 'Favorite'
        ON CONFLICT DO NOTHING
      `);
      cancelFns.push(createNotifyQuery.cancel);
      await createNotifyQuery.result();

      console.log('Migrating likes:', start, ' - ', end, 'done');
    };
  }, 5);

  return res.status(200).json({
    ok: true,
  });
});
