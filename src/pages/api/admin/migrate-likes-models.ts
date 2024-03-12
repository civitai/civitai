import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  cursor: z.coerce.number().optional().default(0),
});

const batchSize = 10;
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  let { cursor } = schema.parse(req.query);
  const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
    SELECT MAX("id") as "maxCursor"
    FROM "Model"
    WHERE status = 'Published';
  `);
  res.on('close', maxCursorQuery.cancel);
  const [{ maxCursor }] = await maxCursorQuery.result();
  console.log('Migrating model metrics:', maxCursor);

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

    // Migrate likes to collects
    tasks.push(async () => {
      if (stop) return;
      console.log('Migrate likes to collects ' + start + '-' + end);
      console.time('Migrate likes to collects ' + start + '-' + end);
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
        AND e."modelId" BETWEEN ${start} AND ${end}
        ON CONFLICT DO NOTHING;
      `);
      cancelFns.push(migrateCollectionsQuery.cancel);
      await migrateCollectionsQuery.result();
      console.timeEnd('Migrate likes to collects ' + start + '-' + end);
    });

    // Migrate likes to thumbs up
    tasks.push(async () => {
      if (stop) return;
      console.log('Migrate likes to thumbs up ' + start + '-' + end);
      console.time('Migrate likes to thumbs up ' + start + '-' + end);
      const migrateCollectionsQuery = await pgDbWrite.cancellableQuery(`
        -- Migrate likes to thumbs up
        INSERT INTO "ResourceReview" ("modelId", "modelVersionId", rating, recommended, "userId", "createdAt", "updatedAt", metadata)
        SELECT DISTINCT on (mv."modelId", me."userId")
          me."modelId",
          mv.id,
          5,
          true,
          me."userId",
          me."createdAt",
          now(),
          '{"migrated": true}'::jsonb
        FROM "ModelEngagement" me
        JOIN "ModelVersion" mv ON mv."modelId" = me."modelId" AND mv."createdAt" < me."createdAt" AND mv.status = 'Published'
        WHERE me.type = 'Favorite'
          AND me."modelId" BETWEEN ${start} AND ${end}
        ORDER BY mv."modelId", me."userId", mv."createdAt" DESC
        ON CONFLICT DO NOTHING;
      `);
      cancelFns.push(migrateCollectionsQuery.cancel);
      await migrateCollectionsQuery.result();
      console.timeEnd('Migrate likes to thumbs up ' + start + '-' + end);
    });
  }

  await limitConcurrency(tasks, 10);

  return res.status(200).json({
    ok: true,
  });
});
