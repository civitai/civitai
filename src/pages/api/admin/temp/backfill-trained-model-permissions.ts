import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off: repair the licensing permissions on models created by on-site training.
 *
 * Until the schema default was corrected, `Model.allowCommercialUse` carried the Prisma default
 * `[Sell]` while the Postgres column default was the full `[Image, RentCivit, Rent, Sell]`. The
 * training wizard creates the model without sending the field, so Prisma supplied its own value and
 * the column default never applied — publishing a licence the creator never chose, including
 * "do not run on Civitai" on a LoRA trained on Civitai.
 *
 * The upload form cannot produce `{Sell}` on its own (selecting Sell force-adds RentCivit and Rent),
 * so an exact `{Sell}` on a Trained model identifies the defaulted rows rather than a creator's
 * choice. Created-uploadType models with the same value are left alone: nothing rules out an API
 * client having set them deliberately.
 *
 * GET /api/admin/temp/backfill-trained-model-permissions?token=<WEBHOOK_TOKEN>
 *   &dryRun=true|false     (default true)
 *   &batchSize=1000        (default 1000; max 5000)
 *
 * Side effects when dryRun=false:
 *   - UPDATE Model.allowCommercialUse to [Image, RentCivit, Rent, Sell] for the matched rows.
 *   - Refresh dataForModelsCache and queue modelsSearchIndex updates so listings, search and the
 *     cached `covered` flag pick the change up rather than waiting out the 1-day TTL.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(5000).default(1000),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  const candidates = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id
    FROM "Model" m
    WHERE m."uploadType" = 'Trained'
      AND m."allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
      AND m.status != 'Deleted'
    ORDER BY m.id
  `;
  const modelIds = candidates.map((r) => r.id);

  if (params.dryRun) {
    return res.status(200).json({
      dryRun: true,
      totalCandidates: modelIds.length,
      sample: modelIds.slice(0, 100),
    });
  }

  let totalUpdated = 0;

  for (let i = 0; i < modelIds.length; i += params.batchSize) {
    const batch = modelIds.slice(i, i + params.batchSize);

    // Re-check the value in the UPDATE: a creator editing one of these between the read above and
    // this write has made a deliberate choice, and it must win over the repair.
    const updated = await dbWrite.$executeRaw`
      UPDATE "Model"
      SET "allowCommercialUse" = ARRAY['Image', 'RentCivit', 'Rent', 'Sell']::"CommercialUse"[]
      WHERE id = ANY(${batch}::int[])
        AND "allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
    `;
    totalUpdated += updated;

    await dataForModelsCache.refresh(batch);
    await modelsSearchIndex.queueUpdate(
      batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );

    console.log(
      `backfill-trained-model-permissions: batch ${Math.floor(i / params.batchSize) + 1} — ` +
        `updated ${updated} of ${batch.length} models`
    );
  }

  res.status(200).json({
    dryRun: false,
    totalCandidates: modelIds.length,
    totalUpdated,
  });
});
