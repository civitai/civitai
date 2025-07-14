import { ClickHouseError } from '@clickhouse/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { createJob, getJobDate } from '~/server/jobs/job';

export const imagesCreatedEvents = createJob('images-created-events', '0 * * * *', async (ctx) => {
  if (!clickhouse) return;
  const [lastRan, setLastRan] = await getJobDate('images-created-events');

  const runContext = {
    on: (event: 'close', listener: () => void) => {
      ctx.on('cancel', async () => listener());
    },
  };
  let updated = 0;

  await dataProcessor({
    params: { batchSize: 10000, concurrency: 10, start: 0 },
    runContext,
    rangeFetcher: async (ctx) => {
      const [{ start, end }] = await dbWrite.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Image" WHERE "createdAt" > ${lastRan}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Image" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
        `;
      updated = end - start;
      return { start, end };
    },
    processor: async ({ start, end, cancelFns }) => {
      console.log('Processing images', start, '-', end);
      const query = await pgDbWrite.cancellableQuery<ImageRow>(`
          SELECT
            "createdAt",
            "userId",
            id,
            "nsfw",
            "nsfwLevel",
            "type"
          FROM "Image"
          WHERE id BETWEEN ${start} AND ${end} AND nsfw != 'Blocked';
        `);
      cancelFns.push(query.cancel);
      const images = await query.result();
      console.log('Fetched images', start, '-', end);
      if (!images.length) return;
      ctx.checkIfCanceled();

      await clickhouse?.insert({
        table: 'images_created',
        format: 'JSONEachRow',
        values: images.map((x) => ({
          id: x.id,
          mediaType: x.type,
          createdAt: x.createdAt,
          nsfw: x.nsfw,
          nsfwLevel: x.nsfwLevel,
          userId: x.userId,
        })),
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 0,
          date_time_input_format: 'best_effort',
        },
      });
      console.log('Updated images', start, '-', end);
    },
  });

  await setLastRan();

  return {
    images: updated,
  };
});

type ImageRow = {
  id: number;
  createdAt: Date;
  userId: number;
  nsfw: string;
  nsfwLevel: number;
  type: string;
};
