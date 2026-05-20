import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataForModelsCache, modelTagCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off cleanup for sub-bug A: detach the `actor` (5161) and `actress` (5162)
 * tags from Published models where the model is not flagged as POI and none of
 * its images are flagged as POI either. These are the high-confidence true
 * mis-tags; bypass-attempt models (image-level POI signal) are intentionally
 * left alone so moderation can review them.
 *
 * GET /api/admin/temp/cleanup-poi-tag-mismatches?token=<WEBHOOK_TOKEN>
 *   &dryRun=true|false           (default true)
 *   &tagIds=5161,5162            (CSV override; default actor+actress)
 *   &batchSize=500               (default 500; max 2000)
 *
 * Side effects when dryRun=false:
 *   - DELETE TagsOnModels rows for (modelId, tagId) pairs that match.
 *   - Refresh modelTagCache and dataForModelsCache for affected modelIds.
 *   - Queue modelsSearchIndex updates so listings/search pick up the change.
 */

const DEFAULT_TAG_IDS = [5161, 5162]; // actor, actress

const schema = z.object({
  dryRun: booleanString().default(true),
  tagIds: z.string().optional(),
  batchSize: z.coerce.number().min(1).max(2000).default(500),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const tagIds = params.tagIds
    ? params.tagIds
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((x) => Number.isInteger(x) && x > 0)
    : DEFAULT_TAG_IDS;

  if (!tagIds.length) {
    return res.status(400).json({ error: 'No valid tagIds provided' });
  }

  // 1) Find candidate model IDs: Published, not POI, has one of the target
  // tags, AND has no image flagged as POI anywhere under it.
  const candidates = await dbRead.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT tom."modelId" AS "modelId"
    FROM "TagsOnModels" tom
    JOIN "Model" m ON m.id = tom."modelId"
    WHERE m."status" = 'Published'
      AND m."poi" = false
      AND tom."tagId" IN (${Prisma.join(tagIds)})
      AND NOT EXISTS (
        SELECT 1
        FROM "ModelVersion" mv
        JOIN "Post" p ON p."modelVersionId" = mv.id
        JOIN "Image" i ON i."postId" = p.id
        WHERE mv."modelId" = tom."modelId"
          AND i."poi" = true
      )
  `;
  const modelIds = candidates.map((r) => r.modelId);

  if (params.dryRun) {
    return res.status(200).json({
      dryRun: true,
      tagIds,
      totalCandidates: modelIds.length,
      sample: modelIds.slice(0, 100),
    });
  }

  let totalDeleted = 0;
  let totalQueued = 0;

  for (let i = 0; i < modelIds.length; i += params.batchSize) {
    const batch = modelIds.slice(i, i + params.batchSize);

    const result = await dbWrite.tagsOnModels.deleteMany({
      where: { modelId: { in: batch }, tagId: { in: tagIds } },
    });
    totalDeleted += result.count;

    await modelTagCache.refresh(batch);
    await dataForModelsCache.refresh(batch);

    await modelsSearchIndex.queueUpdate(
      batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
    totalQueued += batch.length;

    console.log(
      `cleanup-poi-tag-mismatches: batch ${Math.floor(i / params.batchSize) + 1} — ` +
        `deleted ${result.count} tag rows across ${batch.length} models`
    );
  }

  res.status(200).json({
    dryRun: false,
    tagIds,
    totalCandidates: modelIds.length,
    totalDeleted,
    totalQueued,
  });
});
