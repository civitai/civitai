import { ImageIngestionStatus, TagType } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const schema = z.object({
  tags: commaDelimitedStringArray(),
  nsfwLevel: z.coerce.number().refine((v) => Object.values(NsfwLevel).includes(v)),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { tags, nsfwLevel } = schema.parse(req.query);
  if (!tags.length) return res.status(400).json({ error: 'No tags provided' });
  if (!nsfwLevel) return res.status(400).json({ error: 'No nsfwLevel provided' });

  const tagType = nsfwLevel === NsfwLevel.PG ? TagType.Label : TagType.Moderation;
  const updateResult = await pgDbWrite.query<{ id: number }>(`
    UPDATE "Tag"
    SET "nsfwLevel" = ${nsfwLevel}, type = '${tagType}'::"TagType"
    WHERE name IN (${tags.map((tag) => `'${tag}'`)})
      AND "nsfwLevel" != ${nsfwLevel}
    RETURNING id;
  `);
  const tagIds = updateResult.rows.map((r) => r.id);
  if (!tagIds.length) return res.status(200).json({ tagIds, nsfwLevel, noUpdates: true, tags });

  // Return the response early to avoid timeouts
  res.status(200).json({ tagIds, nsfwLevel, tags });

  await batchProcessor({
    params: { concurrency: 5, batchSize: 500, start: 0 },
    runContext: { on: () => null }, // Dummy to avoid issues
    async batchFetcher() {
      const query = await pgDbWrite.cancellableQuery<{ id: number }>(`
        SELECT
          "imageId" as id
        FROM "TagsOnImageDetails"
        WHERE "tagId" IN (${tagIds.join(', ')})
      `);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    async processor({ batch, batchNumber, batchCount }) {
      if (!batch.length) return;
      console.log(`Processing ${batchNumber} of ${batchCount}`);

      const query = await pgDbWrite.cancellableQuery(`
        UPDATE "Image" i
          SET "nsfwLevel" = (
            SELECT COALESCE(MAX(t."nsfwLevel"), 0)
            FROM "TagsOnImageDetails" toi
            JOIN "Tag" t ON t.id = toi."tagId"
            WHERE toi."imageId" = i.id
              AND toi."disabled" IS FALSE
          ),
          "updatedAt" = NOW()
        WHERE id IN (${batch})
          AND i.ingestion = '${ImageIngestionStatus.Scanned}'::"ImageIngestionStatus"
          AND NOT i."nsfwLevelLocked" AND i."nsfwLevel" < ${nsfwLevel};
      `);
      await query.result();
      console.log(`Updated ${batchNumber} of ${batchCount}`);
    },
  });
});
