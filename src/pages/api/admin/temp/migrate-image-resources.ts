import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  console.time('MIGRATION_TIMER');
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery<{
        imageId: number;
        modelVersionId?: number | null;
        name?: number | null;
      }>(Prisma.sql`
        SELECT
          ir."imageId",
          ir."modelVersionId",
          ir.name
        FROM "Image" i
        JOIN "ImageResource" ir ON i.id = ir."imageId"
        WHERE i.id BETWEEN ${start} AND ${end}
      `);

      cancelFns.push(cancel);
      const items = await result();
      const record = items.reduce<Record<string, number>>(
        (acc, { imageId, modelVersionId, name }) => {
          const key = `${imageId}_${modelVersionId}_${name}`;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        },
        {}
      );
      const duplicates = Object.entries(record).filter(([key, value]) => value > 1);
      console.log(duplicates);
      // console.log(`migration: ${start} - ${end}`);
    },
  });

  console.timeEnd('MIGRATION_TIMER');
});
