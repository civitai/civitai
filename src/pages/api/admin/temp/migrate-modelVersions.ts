import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const batchSize = 10000;
export default WebhookEndpoint(async (req, res) => {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  console.log('start');
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "ModelVersion";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "ModelVersion";`
  );

  let cursor = min ?? 0;
  console.log(cursor > maxId);
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating modelVersions ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level as (
          SELECT
            mv.id,
            (
              SELECT
                COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
              FROM (
                SELECT
                  i."nsfwLevel"
                FROM "Post" p
                JOIN "Image" i ON i."postId" = p.id
                WHERE p."modelVersionId" = mv.id
                AND p."userId" = m."userId"
                AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
                ORDER BY p."id", i."index"
                LIMIT 20
              ) AS i
            ) AS "nsfwLevel"
          FROM "ModelVersion" mv
          JOIN "Model" m ON mv."modelId" = m.id
          WHERE mv.id BETWEEN ${start} AND ${end}
        )
        UPDATE "ModelVersion" mv
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = mv.id;
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ finished: true });
});
