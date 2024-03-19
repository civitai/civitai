import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
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
    Prisma.sql`SELECT MAX(id) "max" FROM "Model";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Model";`
  );

  let cursor = min ?? 0;
  console.log(cursor > maxId);
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating models ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON ("modelId")
            mv."modelId" as "id",
            bit_or(mv."nsfwLevel") "nsfwLevel"
          FROM "ModelVersion" mv
          JOIN "Model" m on m.id = mv."modelId"
          WHERE m.id BETWEEN ${start} AND ${end}
          GROUP BY mv.id
        )
        UPDATE "Model" m
        SET "nsfwLevel" = (
          CASE
            WHEN m.nsfw = TRUE THEN ${NsfwLevel.XXX}
            ELSE level."nsfwLevel"
          END
        )
        FROM level
        WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel";
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ finished: true });
});
