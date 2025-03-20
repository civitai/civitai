import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('MIGRATION_TIMER');
  await migrateTagLevels(req, res);
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateTagLevels(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>`
        SELECT MAX(id) "max" FROM "Image";
      `;
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(`
        INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId", "hash", "strength", "detected")
        SELECT
          DISTINCT ON ("imageId", "modelVersionId")
          "imageId",
          "modelVersionId",
          "hash",
          "strength",
          "detected"
        FROM "ImageResource" WHERE "imageId" between 1 and 1000
        AND "modelVersionId" IS NOT NULL
        ON CONFLICT DO NOTHING;
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Processed images ${start} - ${end}`);
    },
  });
}

/**


 */
