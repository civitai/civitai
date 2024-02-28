import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  cursor: z.coerce.number().optional().default(0),
  batchSize: z.coerce.number().optional().default(100),
});

const taskGenerators: ((ctx: MigrationContext) => Task)[] = [
  likesToCollections,
  likesToCollectionItems,
  likesToNotifications,
  likesToReviews,
];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor } = params;
  const { batchSize } = params;
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

  const tasks: Task[] = [];
  while (cursor <= maxCursor) {
    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);
    const ctx = { start, end, stop, cancelFns };

    for (const taskGenerator of taskGenerators) tasks.push(taskGenerator(ctx));
  }

  await limitConcurrency(tasks, 50);

  return res.status(200).json({
    ok: true,
  });
});

type MigrationContext = {
  start: number;
  end: number;
  stop: boolean;
  cancelFns: (() => void)[];
};
// Move likes to bookmarks collections
function likesToCollections(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate likes to bookmarks ' + ctx.start + '-' + ctx.end);
    console.time('Migrate likes to bookmarks ' + ctx.start + '-' + ctx.end);
    const moveToBookmarksQuery = await pgDbWrite.cancellableQuery(`
      -- Move likes to bookmark collections
      INSERT INTO "Collection" ("userId", "name", "description", "type", "availability", "mode")
      SELECT DISTINCT
        me."userId",
        'Favorite Models' "name",
        'Your liked models will appear in this collection.',
        'Model'::"CollectionType" "type",
        'Unsearchable'::"Availability" "availability",
        'Bookmark'::"CollectionMode"
      FROM "ModelEngagement" me
      WHERE "userId" > ${ctx.start} AND "userId" <= ${ctx.end} AND type = 'Favorite'
      AND NOT EXISTS (
        SELECT 1
        FROM "Collection"
        WHERE "userId" = me."userId"
        AND "type" = 'Model'
        AND "mode" = 'Bookmark'
      )
      ON CONFLICT DO NOTHING
    `);
    ctx.cancelFns.push(moveToBookmarksQuery.cancel);
    await moveToBookmarksQuery.result();
    console.timeEnd('Migrate likes to bookmarks ' + ctx.start + '-' + ctx.end);
  };
}

function likesToCollectionItems(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate likes to collects ' + ctx.start + '-' + ctx.end);
    console.time('Migrate likes to collects ' + ctx.start + '-' + ctx.end);
    const migrateCollectionsQuery = await pgDbWrite.cancellableQuery(`
      -- Migrate model likes to collection
      INSERT INTO "CollectionItem" ("collectionId", "modelId", "note", "createdAt")
      SELECT
        c.id,
        e."modelId",
        'Migrated from old likes',
        e."createdAt"
      FROM "ModelEngagement" e
      JOIN "Collection" c ON c."userId" = e."userId" AND c.type = 'Model' AND mode = 'Bookmark'
      WHERE e.type = 'Favorite'
      AND e."userId" BETWEEN ${ctx.start} AND ${ctx.end}
      ON CONFLICT DO NOTHING;
    `);
    ctx.cancelFns.push(migrateCollectionsQuery.cancel);
    await migrateCollectionsQuery.result();
    console.timeEnd('Migrate likes to collects ' + ctx.start + '-' + ctx.end);
  };
}

function likesToNotifications(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate likes to notifications ' + ctx.start + '-' + ctx.end);
    console.time('Migrate likes to notifications ' + ctx.start + '-' + ctx.end);
    const createNotifyQuery = await pgDbWrite.cancellableQuery(`
      -- Create notifications for likes
      INSERT INTO "ModelEngagement" ("userId", "modelId", "type", "createdAt")
      SELECT
        "userId",
        "modelId",
        'Notify',
        "createdAt"
      FROM "ModelEngagement"
      WHERE "userId" > ${ctx.start} AND "userId" <= ${ctx.end} AND type = 'Favorite'
      ON CONFLICT DO NOTHING
    `);
    ctx.cancelFns.push(createNotifyQuery.cancel);
    await createNotifyQuery.result();
    console.timeEnd('Migrate likes to notifications ' + ctx.start + '-' + ctx.end);
  };
}

function likesToReviews(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Migrate likes to reviews ' + ctx.start + '-' + ctx.end);
    console.time('Migrate likes to reviews ' + ctx.start + '-' + ctx.end);
    const createReviewQuery = await pgDbWrite.cancellableQuery(`
      -- Create reviews for likes
      INSERT INTO "ResourceReview" ("userId", "modelId", "modelVersionId", rating, recommended, "createdAt", "updatedAt", metadata)
      SELECT DISTINCT on (mv."modelId", me."userId")
          me."userId",
          me."modelId",
          mv.id,
          5,
          true,
          me."createdAt",
          now(),
          '{"migrated": true}'::jsonb
        FROM "ModelEngagement" me
        JOIN "ModelVersion" mv ON mv."modelId" = me."modelId" AND mv."createdAt" < me."createdAt" AND mv.status = 'Published'
        WHERE me.type = 'Favorite'
          AND me."userId" BETWEEN ${ctx.start} AND ${ctx.end}
        ORDER BY mv."modelId", me."userId", mv."createdAt" DESC
        ON CONFLICT DO NOTHING;
    `);
    ctx.cancelFns.push(createReviewQuery.cancel);
    await createReviewQuery.result();
    console.timeEnd('Migrate likes to reviews ' + ctx.start + '-' + ctx.end);
  };
}
