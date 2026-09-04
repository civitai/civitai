import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { imageResourcesCache } from '~/server/redis/caches';
import { imagesSearchIndex } from '~/server/search-index';
import { createImageResources } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Reconciles already-stored detected resources against what get_image_resources() returns NOW.
 * Run it AFTER the current get_image_resources.sql is applied (pnpm db:program, or by hand): the
 * new filters stop the function crediting an unrelated creator's model when both bundle the same
 * upstream component file, but they do not touch rows written before that.
 *
 * GET /api/admin/temp/reconcile-detected-image-resources?token=<WEBHOOK_TOKEN>
 *   &dryRun=true|false        (default true)
 *   &start=<imageId>          inclusive; defaults to the lowest id with a detected row
 *   &end=<imageId>            exclusive; defaults to unbounded
 *   &modelVersionIds=1,2,3    only reconcile images currently crediting these versions
 *   &batchSize=200            images per pass (default 200, max 1000)
 *   &budgetMs=60000           stop and return a cursor before the gateway times out
 *
 * Resumable: the response carries `nextStart`. Feed it back as `start` until it comes back null.
 * The endpoint is the authority on nothing -- it asks the database function what the answer is and
 * removes rows that disagree, so re-running it is idempotent.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  start: z.coerce.number().int().min(0).optional(),
  end: z.coerce.number().int().min(0).optional(),
  modelVersionIds: z.string().optional(),
  batchSize: z.coerce.number().int().min(1).max(1000).default(200),
  budgetMs: z.coerce.number().int().min(1000).max(120000).default(60000),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const versionIds = params.modelVersionIds
    ?.split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => Number.isInteger(x) && x > 0);

  if (params.modelVersionIds && !versionIds?.length)
    return res.status(400).json({ error: 'modelVersionIds was given but parsed to nothing' });

  const startedAt = Date.now();
  let cursor = params.start ?? 0;
  let imagesScanned = 0;
  let imagesChanged = 0;
  let rowsRemoved = 0;
  const samples: { imageId: number; modelVersionId: number }[] = [];

  while (Date.now() - startedAt < params.budgetMs) {
    const batch = await dbRead.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT irn."imageId"
      FROM "ImageResourceNew" irn
      WHERE irn.detected
        AND irn."imageId" >= ${cursor}
        ${params.end ? Prisma.sql`AND irn."imageId" < ${params.end}` : Prisma.empty}
        ${versionIds?.length ? Prisma.sql`AND irn."modelVersionId" IN (${Prisma.join(versionIds)})` : Prisma.empty}
      ORDER BY irn."imageId"
      LIMIT ${params.batchSize}
    `;
    if (!batch.length) {
      cursor = -1;
      break;
    }

    for (const { imageId } of batch) {
      imagesScanned++;

      // Both reads go to the primary even on a dry run: what comes back decides a DELETE, and the
      // replica can be behind a resource the user just added by hand.
      const [expected, current] = await Promise.all([
        dbWrite.$queryRaw<{ modelversionid: number | null }[]>`
          SELECT modelversionid FROM get_image_resources(${imageId}::int)
        `,
        dbWrite.imageResourceNew.findMany({
          where: { imageId, detected: true },
          select: { modelVersionId: true },
        }),
      ]);

      const keep = new Set(expected.map((r) => r.modelversionid).filter((x): x is number => !!x));
      const stale = current.map((r) => r.modelVersionId).filter((id) => !keep.has(id));
      if (!stale.length) continue;

      imagesChanged++;
      rowsRemoved += stale.length;
      for (const modelVersionId of stale)
        if (samples.length < 25) samples.push({ imageId, modelVersionId });

      if (!params.dryRun) {
        await dbWrite.imageResourceNew.deleteMany({
          where: { imageId, modelVersionId: { in: stale }, detected: true },
        });
        // Rewrites meta.unmatchedResources too, which is what the post editor reads for its
        // "could not be matched" list -- without it the warning keeps naming the removed model.
        await createImageResources({ imageId });
        await imageResourcesCache.refresh(imageId);
        await imagesSearchIndex.queueUpdate([
          { id: imageId, action: SearchIndexUpdateQueueAction.Update },
        ]);
      }
    }

    cursor = batch[batch.length - 1].imageId + 1;
  }

  return res.status(200).json({
    dryRun: params.dryRun,
    imagesScanned,
    imagesChanged,
    rowsRemoved,
    nextStart: cursor === -1 ? null : cursor,
    samples,
  });
});
