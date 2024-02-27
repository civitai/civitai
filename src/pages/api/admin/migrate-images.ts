import { Prisma } from '@prisma/client';
import { chunk } from 'lodash';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isDefined } from '~/utils/type-guards';

const batchSize = 1000;
export default WebhookEndpoint(async (req, res) => {
  const onCancel: (() => Promise<void>)[] = [];
  const shouldStop = false;
  // res.on('close', async () => {
  //   console.log('Cancelling');
  //   shouldStop = true;
  //   await Promise.all(onCancel.map((cancel) => cancel()));
  // });
  console.log('start');
  // const cursorQuery = await pgDbWrite.cancellableQuery<{ end: number }>(Prisma.sql`
  //   SELECT MAX(id) "end" FROM "Image";
  // `);
  // onCancel.push(cursorQuery.cancel);
  // const [{ end: maxImageId }] = await cursorQuery.result();

  // const cursorResult = await dbRead.$queryRaw<{ max: number }[]>`
  //   SELECT id "max" FROM "Image" where "nsfwLevel" > 0 ORDER BY id DESC LIMIT 1
  // `;
  // let cursor = cursorResult.length ? cursorResult[0].max : 0;
  const maxImageId = 5855596;
  let cursor = 5853231;
  console.log(cursor > maxImageId);
  await limitConcurrency(() => {
    if (cursor > maxImageId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating images ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH image_level AS (
          SELECT
            toi."imageId",
            CASE
              WHEN bool_or(t."nsfwLevel" = 32) THEN 32
              WHEN bool_or(t."nsfwLevel" = 16) THEN 16
              WHEN bool_or(t."nsfwLevel" = 8) THEN 8
              WHEN bool_or(t."nsfwLevel" = 4) THEN 4
              WHEN bool_or(t."nsfwLevel" = 2) THEN 2
              ELSE 1
            END "nsfwLevel"
          FROM "TagsOnImage" toi
          JOIN "Tag" t ON t.id = toi."tagId" AND t."nsfwLevel" > 1
          WHERE
            toi."imageId" BETWEEN ${start} AND ${end}
            AND NOT toi.disabled
          GROUP BY toi."imageId"
        )
        UPDATE "Image" i SET "nsfwLevel" = il."nsfwLevel"
        FROM image_level il
        WHERE i.id = il."imageId"
      `);
      onCancel.push(cancel);
      await result();
    };
  }, 10);

  console.log('end');
  res.status(200).json({ processed: maxImageId });
});
