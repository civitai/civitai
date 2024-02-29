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
    Prisma.sql`SELECT MAX(id) "max" FROM "Post";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Post" WHERE "nsfwLevel" = 0;`
  );

  // await dbWrite.$queryRaw`
  //   UPDATE "Post" p
  //   SET "nsfwLevel" = query."nsfwLevel"
  //   FROM (
  //     SELECT "nsfwLevel" from "Image" i where i."postId" = p.id
  //   ) as query
  //   WHERE p.id = 945638
  // `;

  // await dbWrite.$queryRaw`
  //   WITH level AS (
  //     SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
  //     FROM "Post" p
  //     JOIN "Image" i ON i."postId" = p.id
  //     WHERE p.id = 945638
  //     GROUP BY p.id
  //   )
  //   UPDATE "Post" p
  //   SET "nsfwLevel" = level."nsfwLevel"
  //   FROM level
  //   WHERE level.id = p.id;
  // `;

  // const { cancel, result } = await pgDbWrite.cancellableQuery(
  //   Prisma.raw(`
  //     UPDATE "Post" p
  //     SET "nsfwLevel" = (
  //         SELECT bit_or(i."nsfwLevel")
  //         JOIN "Image" i WHERE i."postId" = p.id
  //     )
  //     WHERE p.id = 319719
  //   `)
  // );

  let cursor = min ?? 0;
  console.log(cursor > maxId);
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating posts ${start} - ${end}`);
    // TODO - possibly add `nsfwLevel` to `TagsOnImage`
    return async () => {
      /*
      UPDATE "Post" p
      SET "nsfwLevel" = (
          SELECT bit_or(i."nsfwLevel")
          JOIN "Image" i WHERE i."postId" = p.id
      )
      WHERE p.id BETWEEN ${start} AND ${end} AND p."nsfwLevel" = 0
      */
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`

        WITH level AS (
          SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
          FROM "Post" p
          JOIN "Image" i ON i."postId" = p.id
          WHERE p.id BETWEEN ${start} AND ${end} AND p."nsfwLevel" = 0
          GROUP BY p.id
        )
        UPDATE "Post" p
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = p.id;
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ finished: true });
});
