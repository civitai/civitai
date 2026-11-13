import type { Prisma } from '@prisma/client';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { BLOCK_POSTABLE_APP_ID_META_KEYS } from '~/server/services/blocks/block-image-upload.service';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { BLOCK_IMAGE_MAX_BYTES } from '~/shared/constants/block-image-upload.constants';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { computeImageBlurhash, type ImageBlurhash } from '~/server/utils/image-blurhash';
import { probeStoredImageWithBytes } from '~/server/utils/stored-image-probe';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Backfill the blurhash placeholder onto App Block images created before the server computed it.
 *
 * `persistBlockWorkflowOutputImage` / `persistBlockUploadImage` create rows from bytes that never
 * pass through the browser preprocessor, so until the server computed it those rows got no
 * `metadata.hash/width/height` and no `Image.hash` — and `MediaHash` drew no placeholder while
 * they loaded. This reads each such row's stored object back and writes the values the persist
 * paths now write, from the SAME helper (`computeImageBlurhash`).
 *
 * Population: `type = 'image'` rows stamped with an App Block provenance key
 * (`blockPublishedAppId` / `blockUploadedAppId`) and no `metadata.hash`. A viewer-picked block
 * upload carries no stamp, so it is not reachable from here.
 *
 * Idempotent: a row that has `metadata.hash` is never selected again. `metadata` is merged (stored keys kept), the `hash` column is set, and
 * the `width`/`height` columns are filled only when either one is missing.
 *
 * Dry-run by default: reads and computes everything, writes nothing, and returns what it would
 * write. Trigger:
 *   /api/admin/temp/backfill-block-image-blurhash?token=$WEBHOOK_TOKEN               (dry run)
 *   /api/admin/temp/backfill-block-image-blurhash?token=$WEBHOOK_TOKEN&dryRun=false  (write)
 */
const schema = z.object({
  dryRun: booleanString().default(true),
  concurrency: z.coerce.number().min(1).max(10).default(5),
  batchSize: z.coerce.number().min(1).default(10000),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
  // App Block image rows first appeared mid-July 2026; nothing stamped predates this.
  after: z.coerce.date().default(new Date('2026-07-01')),
});

type CandidateRow = {
  id: number;
  url: string;
  width: number | null;
  height: number | null;
  metadata: Prisma.JsonObject;
};

type Outcome =
  | { id: number; status: 'updated' | 'would-update'; blur: ImageBlurhash }
  | { id: number; status: 'failed'; reason: string };

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const outcomes: Outcome[] = [];

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => (await getIdRange(params.after)) ?? { start: 0, end: 0 },
    processor: async ({ start, end, cancelFns }) => {
      const query = await selectCandidates(start, end);
      cancelFns.push(query.cancel);
      const rows = await query.result();
      if (!rows.length) return;

      const updatedIds: number[] = [];
      await limitConcurrency(
        rows.map((image) => async () => {
          const outcome = await backfillOne(image, params.dryRun);
          outcomes.push(outcome);
          if (outcome.status === 'updated') updatedIds.push(image.id);
        }),
        params.concurrency
      );

      if (updatedIds.length) {
        await queueImageSearchIndexUpdate({
          ids: updatedIds,
          action: SearchIndexUpdateQueueAction.Update,
        });
      }
      console.log(`backfill-block-image-blurhash: range ${start}-${end}, ${rows.length} rows`);
    },
  });

  const count = (status: Outcome['status']) => outcomes.filter((o) => o.status === status).length;
  res.status(200).json({
    finished: true,
    dryRun: params.dryRun,
    candidates: outcomes.length,
    updated: count('updated'),
    wouldUpdate: count('would-update'),
    failed: count('failed'),
    outcomes,
  });
});

/**
 * App Block image rows in `[start, end]` with no placeholder. Selects on BOTH provenance keys to
 * find rows to repair; it decides nothing about who may read them.
 */
function selectCandidates(start: number, end: number) {
  return pgDbRead.cancellableQuery<CandidateRow>(
    `
    SELECT id, url, width, height, metadata
    FROM "Image"
    WHERE id >= $1 AND id <= $2
      AND type = 'image'
      AND metadata ?| $3::text[]
      AND metadata->>'hash' IS NULL
  `,
    [start, end, [...BLOCK_POSTABLE_APP_ID_META_KEYS]]
  );
}

async function backfillOne(image: CandidateRow, dryRun: boolean): Promise<Outcome> {
  let blur: ImageBlurhash;
  try {
    const { bytes } = await probeStoredImageWithBytes(image.url, {
      maxBytes: BLOCK_IMAGE_MAX_BYTES,
    });
    blur = await computeImageBlurhash(bytes);
  } catch (err) {
    return { id: image.id, status: 'failed', reason: (err as Error).message };
  }
  if (dryRun) return { id: image.id, status: 'would-update', blur };

  const fillDims = image.width == null || image.height == null;
  // Merges onto the metadata read by the SELECT; these rows are already scanned, so nothing else
  // is expected to write their metadata in the moments between the two.
  await dbWrite.image.update({
    where: { id: image.id },
    data: {
      hash: blur.hash,
      width: fillDims ? blur.width : image.width,
      height: fillDims ? blur.height : image.height,
      metadata: { ...image.metadata, hash: blur.hash, width: blur.width, height: blur.height },
    },
  });
  return { id: image.id, status: 'updated', blur };
}

/** The first Image id created at or after `after`, through the max id — via `Image_createdAt_id`. */
async function getIdRange(after: Date) {
  const [startRow] = await (
    await pgDbRead.cancellableQuery<{ id: number }>(
      `SELECT id FROM "Image" WHERE "createdAt" >= $1 ORDER BY "createdAt" ASC LIMIT 1`,
      [after]
    )
  ).result();
  const [endRow] = await (
    await pgDbRead.cancellableQuery<{ id: number }>(`SELECT MAX(id) AS id FROM "Image"`)
  ).result();
  if (!startRow || !endRow?.id) return null;
  return { start: startRow.id, end: endRow.id };
}
