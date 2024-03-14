import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, sleep, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { formatBytes } from '~/utils/number-helpers';

const schema = z.object({
  cursor: z.coerce.number().min(0).optional().default(0),
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  maxCursor: z.coerce.number().min(0).optional(),
  batchSize: z.coerce.number().min(0).optional().default(100),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

const taskGenerators: ((ctx: MigrationContext) => Task)[] = [
  // likesToCollections,
  // likesToCollectionItems,
  // likesToNotifications,
  likesToNotificationsUpdate,
  // likesToReviews,
];

async function getReplicationLag(limit = 1024 ** 2 * 100) {
  const result = await pgDbWrite.query<{
    avg: number;
    max: number;
    min_over_limit: number | null;
    avg_below_limit: number | null;
    count: number;
    clients: number;
  }>(`
    WITH replication_lag AS (
      SELECT
        client_addr AS client,
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag
      FROM pg_stat_replication
      WHERE client_addr IS NOT NULL
    )
    SELECT
      AVG(lag) as avg,
      MAX(lag) as max,
      MIN(IIF(lag > (1024*1024*100), lag, null)) as min_over_limit,
      AVG(IIF(lag < (1024*1024*100), lag, null)) as avg_below_limit,
      SUM(IIF(lag > (1024*1024*100), 1, 0)) AS count,
      COUNT(*) AS clients
    FROM replication_lag;
  `);
  return result.rows[0];
}

const MAX_LAG = 1024 ** 2 * 100; // 100MB
const LAGGING_LIMIT = 2;
const LAG_CHECK_INTERVAL = 10000;
let lagWaiting = false;
let lagPromise: Promise<void> | undefined;
function waitForLag() {
  // Use a single promise for all threads...
  if (lagPromise) return lagPromise;

  lagPromise = new Promise<void>(async (resolve) => {
    let lagging: number | null = null;
    while (lagging === null || lagging > LAGGING_LIMIT) {
      const lag = await getReplicationLag(MAX_LAG);
      lagging = lag.count;

      const lagStats = [
        `${lag.count} lagging by ${formatBytes(lag.min_over_limit ?? 0)}`,
        `${lag.clients - lag.count} ready with ${formatBytes(lag.avg_below_limit ?? 0)} avg lag`,
      ].join(' | ');
      if (lagging > LAGGING_LIMIT) {
        lagWaiting = true;
        console.log(`Replication: ${lagStats}  - Waiting`);
        await sleep(LAG_CHECK_INTERVAL);
      } else if (lagWaiting) {
        lagWaiting = false;
        console.log(`Replication: ${lagStats} - Resuming`);
      }
    }
    resolve();
    lagPromise = undefined;
  });
  return lagPromise;
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor, maxCursor } = params;
  const { batchSize, after, before, concurrency } = params;
  if (maxCursor === undefined) {
    const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
      SELECT MAX("userId") as "maxCursor"
      FROM "ModelEngagement"
      WHERE type = 'Favorite';
    `);
    res.on('close', maxCursorQuery.cancel);
    [{ maxCursor }] = await maxCursorQuery.result();
  }
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
    const ctx = { start, end, stop, cancelFns, after, before };

    for (const taskGenerator of taskGenerators) tasks.push(taskGenerator(ctx));
  }

  // await waitForLag();
  await limitConcurrency(tasks, {
    limit: concurrency,
    // betweenTasksFn: waitForLag,
  });

  console.log('Migration complete:', maxCursor);
  return res.status(200).json({
    ok: true,
  });
});

type MigrationContext = {
  start: number;
  end: number;
  after?: Date;
  before?: Date;
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
        ${ctx.after ? `AND me."createdAt" > '${ctx.after.toISOString()}'` : ''}
        ${ctx.before ? `AND me."createdAt" < '${ctx.before.toISOString()}'` : ''}
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
        ${ctx.after ? `AND e."createdAt" > '${ctx.after.toISOString()}'` : ''}
        ${ctx.before ? `AND e."createdAt" < '${ctx.before.toISOString()}'` : ''}
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
        ${ctx.after ? `AND "createdAt" > '${ctx.after.toISOString()}'` : ''}
        ${ctx.before ? `AND "createdAt" < '${ctx.before.toISOString()}'` : ''}
      ON CONFLICT DO NOTHING
    `);
    ctx.cancelFns.push(createNotifyQuery.cancel);
    await createNotifyQuery.result();
    console.timeEnd('Migrate likes to notifications ' + ctx.start + '-' + ctx.end);
  };
}

function likesToNotificationsUpdate(ctx: MigrationContext) {
  return async () => {
    if (ctx.stop) return;
    console.log('Update likes to notifications ' + ctx.start + '-' + ctx.end);
    console.time('Update likes to notifications ' + ctx.start + '-' + ctx.end);
    const createNotifyQuery = await pgDbWrite.cancellableQuery(`
      -- Create notifications for likes
      UPDATE "ModelEngagement" SET type = 'Notify'
      WHERE "userId" > ${ctx.start} AND "userId" <= ${ctx.end} AND type = 'Favorite'
        ${ctx.after ? `AND "createdAt" > '${ctx.after.toISOString()}'` : ''}
        ${ctx.before ? `AND "createdAt" < '${ctx.before.toISOString()}'` : ''}
    `);
    ctx.cancelFns.push(createNotifyQuery.cancel);
    await createNotifyQuery.result();
    console.timeEnd('Update likes to notifications ' + ctx.start + '-' + ctx.end);
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
          ${ctx.after ? `AND me."createdAt" > '${ctx.after.toISOString()}'` : ''}
          ${ctx.before ? `AND me."createdAt" < '${ctx.before.toISOString()}'` : ''}
        ORDER BY mv."modelId", me."userId", mv."createdAt" DESC
        ON CONFLICT DO NOTHING;
    `);
    ctx.cancelFns.push(createReviewQuery.cancel);
    await createReviewQuery.result();
    console.timeEnd('Migrate likes to reviews ' + ctx.start + '-' + ctx.end);
  };
}
