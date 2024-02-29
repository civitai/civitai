import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
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
  const [{ max: maxImageId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Image" WHERE "nsfwLevel" = 0;`
  );

  let cursor = min ?? 0;
  console.log(cursor > maxImageId);
  await limitConcurrency(() => {
    if (cursor > maxImageId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating images ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        UPDATE "Image" i
        SET "nsfwLevel" = (
          SELECT COALESCE(MAX(t."nsfwLevel"), 0)
          FROM "TagsOnImage" toi
          JOIN "Tag" t ON t.id = toi."tagId"
          WHERE toi."imageId" = i.id
            AND NOT toi.disabled
        )
        WHERE i.id BETWEEN ${start} AND ${end} AND i."nsfwLevel" = 0
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ finished: true });
});
