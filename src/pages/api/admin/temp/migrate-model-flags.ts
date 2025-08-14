import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { ingestModel } from '~/server/services/model.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(10).optional().default(1),
  batchSize: z.coerce.number().min(0).optional().default(100),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  try {
    const params = schema.parse(req.query);
    let totalProcessed = 0;

    await dataProcessor({
      params,
      runContext: res,
      rangeFetcher: async (context) => {
        if (params.after) {
          const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
            WITH dates AS (
              SELECT
              MIN("createdAt") as start,
              MAX("createdAt") as end
              FROM "Model" WHERE "createdAt" > ${params.after}
            )
            SELECT MIN(id) as start, MAX(id) as end
            FROM "Model" i
            JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
          return results[0];
        }
        const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
          Prisma.sql`SELECT MAX(id) "max" FROM "Model";`
        );
        return { ...context, end: max };
      },
      processor: async ({ start, end, cancelFns }) => {
        const modelsQuery = await pgDbWrite.cancellableQuery<{
          id: number;
          name: string;
          description: string;
          poi: boolean;
          nsfw: boolean;
          minor: boolean;
          sfwOnly: boolean;
        }>(Prisma.sql`
          SELECT id, name, description, poi, nsfw, minor, sfwOnly
          FROM "Model"
          WHERE id BETWEEN ${start} AND ${end}
            AND (status = 'Published'::"ModelStatus" OR status = 'Scheduled'::"ModelStatus")
        `);
        cancelFns.push(modelsQuery.cancel);

        const models = await modelsQuery.result();
        if (!models.length) return;

        const toIngest = models.map(ingestModel);
        await Promise.all(toIngest);
        totalProcessed += toIngest.length;

        console.log(`Processed models ${start} - ${end}`, { totalProcessed });
      },
    });

    return res.status(200).json({ fiished: true, totalProcessed });
  } catch (error) {
    const e = error as Error;
    return res.status(500).json({ error: e.message, query: req.query });
  }
});
