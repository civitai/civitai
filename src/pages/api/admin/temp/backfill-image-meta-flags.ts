import * as z from 'zod';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Loads "ImageMetaFlags" for images predating its trigger; re-runnable (rows are upserted).
 *   /api/admin/temp/backfill-image-meta-flags?token=$WEBHOOK_TOKEN&dryRun=false&start=1&end=143000000
 */
const schema = z.object({
  dryRun: booleanString().default(true),
  concurrency: z.coerce.number().min(1).max(10).default(3),
  batchSize: z.coerce.number().min(1).default(50000),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  let totalWritten = 0;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => {
      const { rows } = await pgDbWrite.query<{ start: number; end: number }>(
        'SELECT MIN(id) as start, MAX(id) as end FROM "Image"'
      );
      return rows[0];
    },
    processor: async ({ start, end, cancelFns }) => {
      if (params.dryRun) {
        const { rows } = await pgDbWrite.query<{ missing: number }>(`
          SELECT COUNT(*)::int as missing
          FROM "Image" i
          LEFT JOIN "ImageMetaFlags" f ON f."imageId" = i.id
          WHERE i.id BETWEEN ${start} AND ${end} AND f."imageId" IS NULL
        `);
        totalWritten += rows[0]?.missing ?? 0;
        return;
      }

      const query = await pgDbWrite.cancellableQuery(`
        INSERT INTO "ImageMetaFlags" ("imageId", "hasMeta", "onSite")
        SELECT
          i.id,
          (i.meta IS NOT NULL AND jsonb_typeof(i.meta) <> 'null'),
          (
            i.meta->>'civitaiResources' IS NOT NULL
            AND NOT (i.meta ? 'Version')
            AND (NOT (i.meta ? 'Model') OR (i.meta->>'Model') LIKE 'urn:air:%')
          )
        FROM "Image" i
        WHERE i.id BETWEEN ${start} AND ${end}
        ON CONFLICT ("imageId") DO UPDATE
          SET "hasMeta" = EXCLUDED."hasMeta", "onSite" = EXCLUDED."onSite"
          WHERE "ImageMetaFlags"."hasMeta" IS DISTINCT FROM EXCLUDED."hasMeta"
             OR "ImageMetaFlags"."onSite" IS DISTINCT FROM EXCLUDED."onSite"
      `);
      cancelFns.push(query.cancel);
      const result = await query.result();
      totalWritten += Array.isArray(result) ? result.length : 0;
    },
  });

  return res.status(200).json({ ok: true, dryRun: params.dryRun, totalWritten });
});
