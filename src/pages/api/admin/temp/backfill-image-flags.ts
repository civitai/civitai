import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(2),
  batchSize: z.coerce.number().min(0).optional().default(5000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('BACKFILL_IMAGE_FLAGS_TIMER');
  await backfillImageFlags(req, res);
  console.timeEnd('BACKFILL_IMAGE_FLAGS_TIMER');
  res.status(200).json({ finished: true });
});

async function backfillImageFlags(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  console.log({ params });

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      const [{ max }] = await dbWrite.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("id") "max" FROM "Image";`
      );

      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      console.log(`Processing images ${start} - ${end}`);
      console.time(`Updated images ${start} - ${end}`);

      const updateQuery = await pgDbWrite.cancellableQuery(`
        -- OPTIMIZED: Single query with LEFT JOIN
        WITH image_batch AS (
            SELECT id FROM "Image" WHERE id > ${start} AND id <= ${end}
        )
        UPDATE "Image" i
        SET flags = (
            -- Bits 1-6: Sync from boolean columns
            (CASE WHEN i."nsfwLevelLocked" THEN 1 ELSE 0 END) |
            (CASE WHEN i."tosViolation"    THEN 2 ELSE 0 END) |
            (CASE WHEN i."hideMeta"        THEN 4 ELSE 0 END) |
            (CASE WHEN i."minor"           THEN 8 ELSE 0 END) |
            (CASE WHEN i."poi"             THEN 16 ELSE 0 END) |
            (CASE WHEN i."acceptableMinor" THEN 32 ELSE 0 END) |

            -- Bits 7-8: From ImageFlag table (COALESCE handles NULL from LEFT JOIN)
            (CASE WHEN COALESCE(if_data."promptNsfw", false) THEN 64 ELSE 0 END) |
            (CASE WHEN COALESCE(if_data."resourcesNsfw", false) THEN 128 ELSE 0 END) |

            -- Bits 13-14: Calculate from meta
            (CASE WHEN (i.meta->>'prompt' IS NOT NULL) THEN 8192 ELSE 0 END) |
            (CASE WHEN (
                ((i.meta->>'civitaiResources' IS NOT NULL) AND NOT (i.meta ? 'Version'))
                OR (i.meta->>'engine' = ANY(ARRAY['veo3','vidu','minimax','kling','lightricks','haiper','mochi','hunyuan','wan','sora']))
            ) THEN 16384 ELSE 0 END)
        )
        FROM image_batch ib
        LEFT JOIN "ImageFlag" if_data ON if_data."imageId" = ib.id
        WHERE i.id = ib.id;
      `);

      cancelFns.push(updateQuery.cancel);
      await updateQuery.result();

      console.timeEnd(`Updated images ${start} - ${end}`);
    },
  });
}
