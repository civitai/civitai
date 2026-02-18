import sharp from 'sharp';
import { encode } from 'blurhash';
import { z } from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getClampedSize } from '~/utils/blurhash';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(10).optional().default(3),
  batchSize: z.coerce.number().min(1).optional().default(50),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('BACKFILL_BLURHASH');
  const params = schema.parse(req.query);
  let processed = 0;
  let failed = 0;

  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery<{ id: number }>(`
        SELECT i.id
        FROM "Image" i
        JOIN "Challenge" c ON c."coverImageId" = i.id
        WHERE i.hash IS NULL
        ORDER BY i.id
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      console.log(`Found ${results.length} challenge cover images to backfill`);
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      const detailsQuery = await pgDbRead.cancellableQuery<{ id: number; url: string }>(
        `SELECT id, url FROM "Image" WHERE id = ANY($1::int[])`,
        [batch]
      );
      cancelFns.push(detailsQuery.cancel);
      const images = await detailsQuery.result();

      for (const image of images) {
        try {
          const imageUrl = getEdgeUrl(image.url, { original: true });
          const response = await fetch(imageUrl);
          if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

          const buffer = Buffer.from(await response.arrayBuffer());
          const metadata = await sharp(buffer).metadata();
          if (!metadata.width || !metadata.height) throw new Error('Missing image dimensions');

          const { width: originalWidth, height: originalHeight } = metadata;
          const clamped = getClampedSize(originalWidth, originalHeight, 64);

          const { data, info } = await sharp(buffer)
            .resize(clamped.width, clamped.height)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);

          const updateQuery = await pgDbWrite.cancellableQuery(
            `UPDATE "Image" SET hash = $1, width = $2, height = $3 WHERE id = $4`,
            [hash, originalWidth, originalHeight, image.id]
          );
          cancelFns.push(updateQuery.cancel);
          await updateQuery.result();
          processed++;
        } catch (e) {
          failed++;
          console.error(`Failed image ${image.id}:`, (e as Error).message);
        }
      }
      console.log(`Batch ${batchNumber}/${batchCount} done (processed: ${processed}, failed: ${failed})`);
    },
  });

  console.timeEnd('BACKFILL_BLURHASH');
  res.status(200).json({ finished: true, processed, failed });
});
