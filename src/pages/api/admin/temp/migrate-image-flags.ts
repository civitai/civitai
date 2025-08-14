import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { hasNsfwPrompt } from '~/utils/metadata/audit';

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
  let totalInserted = 0;

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
            FROM "Image" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Image" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const imagesQuery = await pgDbWrite.cancellableQuery<{
        id: number;
        prompt?: string;
        nsfwLevel: number;
        resources: Array<{ id: number; nsfw: boolean }>;
      }>(Prisma.sql`
        SELECT
          i.id,
          i.meta->>'prompt' as prompt,
          i."nsfwLevel"
        FROM "Image" i
        WHERE i.id BETWEEN ${start} AND ${end}
          AND "nsfwLevel" = 1
      `);
      cancelFns.push(imagesQuery.cancel);

      /*
      (
            SELECT
              coalesce(json_agg(agg), '[]')
            FROM (
              SELECT
                m.id,
                m.nsfw
              FROM "ImageResourceNew" ir
              LEFT JOIN "ModelVersion" mv on ir."modelVersionId" = mv.id
              JOIN "Model" m on mv."modelId" = m.id
              WHERE ir."imageId" = i.id
            ) as agg
          ) as "resources"

      */

      const images = await imagesQuery.result();

      const toInsert = images
        .map(({ id, prompt, resources, nsfwLevel }) => {
          return {
            id,
            promptNsfw: hasNsfwPrompt(prompt),
            nsfwLevel,
            resourcesNsfw: false,
            // resourcesNsfw: resources.some((x) => x.nsfw)
          };
        })
        .filter((x) => x.promptNsfw || x.resourcesNsfw);

      totalProcessed += images.length;
      totalInserted += toInsert.length;

      if (toInsert.length > 0) {
        const insertQuery = await pgDbWrite.cancellableQuery(Prisma.sql`
          INSERT INTO "ImageFlag" ("imageId", "promptNsfw", "resourcesNsfw")
          VALUES ${Prisma.raw(
            toInsert
              .map(
                ({ id, promptNsfw, resourcesNsfw }) => `(${id}, ${promptNsfw}, ${resourcesNsfw})`
              )
              .join(', ')
          )}
          ON CONFLICT ("imageId") DO UPDATE SET "promptNsfw" = EXCLUDED."promptNsfw", "resourcesNsfw" = EXCLUDED."resourcesNsfw";
        `);
        cancelFns.push(insertQuery.cancel);
        await insertQuery.result();
      }
      console.log(`Processed images ${start} - ${end}`, {
        totalProcessed,
        totalInserted,
      });
    },
  });
});
