import { Prisma } from '@prisma/client';
import { chunk } from 'lodash';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isDefined } from '~/utils/type-guards';

// const batchSize = 500;
// export default WebhookEndpoint(async (req, res) => {
//   let counter = 0;
//   let nextCursor: number | undefined;
//   let index = 0;
//   console.log('start');
//   const tagMap = await getTagMap();
//   console.log('got tags');

//   async function go() {
//     const results = await getImageIds({ cursor: nextCursor, limit: batchSize * 10 });
//     console.log('got images');
//     const imageIds = results.items.map((x) => x.id);

//     const imageNsfwLevels = results.items.map(({ id, tags }) => {
//       const nsfwLevels = tags.map((x) => tagMap.get(x.tagId) ?? 1);
//       const nsfwLevel = Math.max(...nsfwLevels);
//       return { id, nsfwLevel };
//     });

//     if (imageNsfwLevels.length) {
//       const batches = chunk(imageNsfwLevels, batchSize);
//       for (const batch of batches) {
//         console.time(`updateNsfwLevels:${index}`);
//         const toUpdate = batch.reduce<Partial<Record<number, number[]>>>((acc, val) => {
//           acc[val.nsfwLevel] = [...(acc[val.nsfwLevel] ?? []), val.id];
//           return acc;
//         }, {});
//         await Promise.all(
//           Object.entries(toUpdate).map(async ([key, ids]) => {
//             const nsfwLevel = Number(key);
//             await dbWrite.image.updateMany({ where: { id: { in: ids } }, data: { nsfwLevel } });
//           })
//         );
//         console.timeEnd(`updateNsfwLevels:${index}`);

//         // console.time(`updateNsfwLevels:${index}`);
//         // await dbWrite.$executeRawUnsafe(
//         //   `SELECT update_image_nsfw_levels(ARRAY[${batch.join(',')}])`
//         // );
//         // console.timeEnd(`updateNsfwLevels:${index}`);
//       }
//     }

//     counter += imageIds.length;
//     console.log({ nextCursor: results.nextCursor });
//     return results.nextCursor;
//   }

//   nextCursor = await go();
//   while (nextCursor) {
//     index++;
//     nextCursor = await go();
//     if (counter % 10000 === 0) console.log(`processed: ${counter}`);
//   }

//   console.log('end');
//   res.status(200).json({ processed: counter });
// });

// async function getImageIds({ cursor, limit }: { cursor?: number; limit: number }) {
//   const items = await dbRead.image.findMany({
//     take: limit + 1,
//     cursor: cursor ? { id: cursor } : undefined,
//     where: { nsfwLevel: 0 },
//     select: { id: true, tags: { select: { tagId: true } } },
//   });
//   let nextCursor: number | undefined;
//   if (items.length > limit) {
//     const nextItem = items.pop();
//     nextCursor = nextItem?.id;
//   }

//   return { items, nextCursor };
// }

// async function getTagMap() {
//   const tags = await dbRead.tag.findMany({ select: { id: true, nsfwLevel: true } });
//   return new Map(tags.map(({ id, nsfwLevel }) => [id, nsfwLevel]));
// }

const batchSize = 10000;
export default WebhookEndpoint(async (req, res) => {
  console.log('start');
  const [{ start, end: maxImageId }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
    SELECT
      MAX(IIF("nsfwLevel" != 0, id, 0)) "start",
      MAX(id) "end"
    FROM "Image";
  `;
  console.log({ maxImageId });

  // const cursorResult = await dbRead.$queryRaw<{ max: number }[]>`
  //   SELECT id "max" FROM "Image" where "nsfwLevel" > 0 ORDER BY id DESC LIMIT 1
  // `;
  // let cursor = cursorResult.length ? cursorResult[0].max : 0;
  let cursor = start;
  console.log({ cursor });
  await limitConcurrency(() => {
    if (cursor > maxImageId) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    console.log(`Updating images ${start} - ${end}`);
    return async () => {
      await pgDbWrite.query(Prisma.sql`
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
    };
  }, 3);

  console.log('end');
  res.status(200).json({ processed: maxImageId });
});
