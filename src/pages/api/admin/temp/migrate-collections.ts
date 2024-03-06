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
    Prisma.sql`SELECT MAX(id) "max" FROM "Collection";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Collection";`
  );

  let cursor = min ?? 0;
  console.log(cursor > maxId);
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating collections ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel",0)), 0)
            FROM "CollectionItem" ci
            LEFT JOIN "Image" i on i.id = ci."imageId" AND c.type = 'Image'
            LEFT JOIN "Post" p on p.id = ci."postId" AND c.type = 'Post'
            LEFT JOIN "Model" m on m.id = ci."modelId" AND c.type = 'Model'
            LEFT JOIN "Article" a on a.id = ci."articleId" AND c.type = 'Article'
            WHERE ci."collectionId" = c.id
          )
          WHERE c.id BETWEEN ${start} AND ${end};
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ finished: true });
});

/*
          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT bit_or(i."nsfwLevel")
            FROM "CollectionItem" ci
            JOIN "Image" i on i.id = ci."imageId"
          )
          WHERE c.type = 'Image' AND c.id BETWEEN ${start} AND ${end} AND c."nsfwLevel" = 0;

          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT bit_or(i."nsfwLevel")
            FROM "CollectionItem" ci
            JOIN "Post" i on i.id = ci."postId"
          )
          WHERE c.type = 'Post' AND c.id BETWEEN ${start} AND ${end} AND c."nsfwLevel" = 0;

          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT bit_or(i."nsfwLevel")
            FROM "CollectionItem" ci
            JOIN "Model" i on i.id = ci."modelId"
          )
          WHERE c.type = 'Model' AND c.id BETWEEN ${start} AND ${end} AND c."nsfwLevel" = 0;

          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT bit_or(i."nsfwLevel")
            FROM "CollectionItem" ci
            JOIN "Article" i on i.id = ci."articleId"
          )
          WHERE c.type = 'Article' AND c.id BETWEEN ${start} AND ${end} AND c."nsfwLevel" = 0;
*/
