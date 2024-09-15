import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { hasNsfwWords } from '~/utils/metadata/audit';

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
  let totalProcessed = 0;
  let totalTitleNsfw = 0;

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
      const modelsQuery = await pgDbWrite.cancellableQuery<{ id: number; name: string }>(Prisma.sql`
        SELECT id, name FROM "Model" WHERE id BETWEEN ${start} AND ${end}
      `);
      cancelFns.push(modelsQuery.cancel);

      const models = await modelsQuery.result();

      const toInsert = models
        .map(({ id, name }) => {
          return { id, titleNsfw: hasNsfwWords(name) };
        })
        .filter((x) => x.titleNsfw);
      totalProcessed += models.length;
      totalTitleNsfw += toInsert.length;

      const insertQuery = await pgDbWrite.cancellableQuery(Prisma.sql`
        INSERT INTO "ModelFlag" ("modelId", "titleNsfw")
        VALUES ${Prisma.raw(
          toInsert.map(({ id, titleNsfw }) => `(${id}, ${titleNsfw})`).join(', ')
        )}
        ON CONFLICT DO NOTHING;
      `);
      cancelFns.push(insertQuery.cancel);
      await insertQuery.result();
      console.log(`Processed models ${start} - ${end}`, { totalProcessed, totalTitleNsfw });
    },
  });
});
