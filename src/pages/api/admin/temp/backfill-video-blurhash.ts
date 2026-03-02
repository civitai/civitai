import { encode } from 'blurhash';
import sharp from 'sharp';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { booleanString } from '~/utils/zod-helpers';

const BAD_HASH = 'U00000fQfQfQfQfQfQfQfQfQfQfQfQfQfQfQ';

const schema = z.object({
  dryRun: booleanString().default(true),
  concurrency: z.coerce.number().min(1).max(10).default(10),
  batchSize: z.coerce.number().min(1).default(10000),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().default(new Date('2026-01-16')),
  before: z.coerce.date().default(new Date('2026-02-20')),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  // Dry run: return the ID range without scanning for exact count
  if (params.dryRun) {
    const idRange = await getIdRange(params.after, params.before);
    if (!idRange) return res.status(200).json({ dryRun: true, idRange: null });
    return res.status(200).json({ dryRun: true, ...idRange });
  }

  let processed = 0;
  let failed = 0;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => {
      const idRange = await getIdRange(params.after, params.before);
      return idRange ?? { start: 0, end: 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      // Fetch videos with bad hash in this ID range using PK scan
      const fetchQuery = await pgDbRead.cancellableQuery<{
        id: number;
        url: string;
        width: number;
        height: number;
      }>(
        `
        SELECT id, url, width, height
        FROM "Image"
        WHERE id >= $1 AND id <= $2
          AND type = 'video'
          AND hash = $3
      `,
        [start, end, BAD_HASH]
      );
      cancelFns.push(fetchQuery.cancel);
      const images = await fetchQuery.result();

      if (!images.length) return;

      // Process each image with concurrency control
      const updatedIds: number[] = [];
      const tasks = images.map((image) => async () => {
        try {
          const frameUrl = getEdgeUrl(image.url, {
            width: 450,
            transcode: true,
            anim: false,
          });
          const response = await fetch(frameUrl);
          if (!response.ok) {
            console.error(`Failed to fetch frame for image ${frameUrl}: ${response.status}`);
            failed++;
            return;
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          const { data, info } = await sharp(buffer)
            .raw()
            .ensureAlpha()
            .resize(64, 64, { fit: 'inside' })
            .toBuffer({ resolveWithObject: true });

          const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
          if (hash === BAD_HASH) {
            console.warn(`Image ${image.id} still produced bad hash, skipping update`);
            failed++;
            return;
          }

          const updateQuery = await pgDbWrite.cancellableQuery(
            `UPDATE "Image" SET hash = $1 WHERE id = $2`,
            [hash, image.id]
          );
          cancelFns.push(updateQuery.cancel);
          await updateQuery.result();
          updatedIds.push(image.id);
          processed++;
        } catch (e) {
          const frameUrl = getEdgeUrl(image.url, {
            width: 450,
            transcode: true,
            anim: false,
          });
          console.error(`Error processing image ${frameUrl}:`, (e as Error).message);
          failed++;
        }
      });

      await limitConcurrency(tasks, params.concurrency);

      // Queue search index updates for successfully updated images
      if (updatedIds.length) {
        await queueImageSearchIndexUpdate({
          ids: updatedIds,
          action: SearchIndexUpdateQueueAction.Update,
        });
      }

      console.log(`Range ${start}-${end} done (processed: ${processed}, failed: ${failed})`);
    },
  });

  res.status(200).json({ finished: true, processed, failed, dryRun: false });
});

/** Convert a date window into an Image ID range using fast index lookups on Image_createdAt_id */
async function getIdRange(after: Date, before: Date) {
  const [startResult] = await (
    await pgDbRead.cancellableQuery<{ id: number }>(
      `SELECT id FROM "Image" WHERE "createdAt" >= $1 ORDER BY "createdAt" ASC LIMIT 1`,
      [after]
    )
  ).result();
  const [endResult] = await (
    await pgDbRead.cancellableQuery<{ id: number }>(
      `SELECT id FROM "Image" WHERE "createdAt" < $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [before]
    )
  ).result();

  if (!startResult || !endResult) return null;
  return { start: startResult.id, end: endResult.id };
}
