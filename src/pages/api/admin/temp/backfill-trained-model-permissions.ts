import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off, two actions, for the coverage change in
 * `20260817120000_generation_coverage_require_rentcivit`.
 *
 * repair (default) — fix the licensing permissions on models created by on-site training.
 *
 * Until the schema default was corrected, `Model.allowCommercialUse` carried the Prisma default
 * `[Sell]` while the Postgres column default was the full `[Image, RentCivit, Rent, Sell]`. The
 * training wizard creates the model without sending the field, so Prisma supplied its own value and
 * the column default never applied — publishing a licence the creator never chose, including
 * "do not run on Civitai" on a LoRA trained on Civitai.
 *
 * `{Sell}` identifies those rows because the upload form cannot produce it: selecting Sell
 * force-adds RentCivit and Rent, then disables both boxes. **That cascade landed in b5455112c2 on
 * 2024-06-11.** Before it, the field was a plain checkbox group where ticking only "Sell this model
 * or merges" produced exactly `{Sell}` deliberately — so rows created earlier are excluded. On the
 * prod replica that is 2,577 of 124,334 candidates, and widening them would overwrite a stated
 * permission, which is the opposite of what this change is for.
 *
 * Created-uploadType models with the same value are also left alone: nothing rules out an API
 * client having set them deliberately.
 *
 * ⚠️ The candidate set spans every status except Deleted, not only Published — on the prod replica
 * 121,754 rows, of which 65,974 are Published and the rest Draft / Unpublished /
 * UnpublishedViolation / Scheduled / Training. Unpublished and violation-removed models are
 * included on purpose: a restored model must not come back carrying a licence its creator never set.
 *
 * reindex — queue models that WITHHOLD RentCivit for a search-index update.
 *
 * `models.search-index.ts` derives `canGenerate` from generation coverage, and nothing re-indexes a
 * model when a view definition changes underneath it. Without this the models the new view uncovers
 * keep `canGenerate: true` in Meilisearch — still listed under the on-site-generation filter — until
 * something unrelated touches them.
 *
 * The predicate is the difference between the two view definitions — withholding RentCivit while
 * granting Rent or Sell — rather than the view itself, so it gives the same answer run either side
 * of the swap. Withholding all three changes nothing: those models were uncovered before too. On
 * the prod replica that is 3,995 models post-repair (2,444 Published) against 63,162 for a bare
 * "withholds RentCivit". Re-indexing a model whose coverage did not move is a no-op, so the query
 * errs wide.
 *
 * GET /api/admin/temp/backfill-trained-model-permissions?token=<WEBHOOK_TOKEN>
 *   &action=repair|reindex   (default repair)
 *   &dryRun=true|false       (default true)
 *   &batchSize=1000          (default 1000; max 2000)
 *   &limit=<n>               (optional; bound a first run to prove the shape)
 *
 * Side effects when dryRun=false:
 *   - repair:  UPDATE Model.allowCommercialUse to [Image, RentCivit, Rent, Sell] for matched rows,
 *              and queue modelsSearchIndex updates for them.
 *   - reindex: queue modelsSearchIndex updates only.
 *
 * Both responses return every id touched — a mass licence change needs a record of which rows moved.
 */

/** b5455112c2 — before this, a bare {Sell} was reachable through the form and meant it. */
const CASCADE_LANDED_AT = new Date('2024-06-11T00:00:00Z');

const schema = z.object({
  action: z.enum(['repair', 'reindex']).default('repair'),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(2000).default(1000),
  limit: z.coerce.number().min(1).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  const candidates =
    params.action === 'repair'
      ? await dbRead.$queryRaw<{ id: number }[]>`
          SELECT m.id
          FROM "Model" m
          WHERE m."uploadType" = 'Trained'
            AND m."allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
            AND m.status != 'Deleted'
            AND m."createdAt" >= ${CASCADE_LANDED_AT}
          ORDER BY m.id
        `
      : await dbRead.$queryRaw<{ id: number }[]>`
          SELECT m.id
          FROM "Model" m
          WHERE NOT (m."allowCommercialUse" && ARRAY['RentCivit']::"CommercialUse"[])
            AND m."allowCommercialUse" && ARRAY['Rent', 'Sell']::"CommercialUse"[]
            AND m.status != 'Deleted'
          ORDER BY m.id
        `;

  const modelIds = (params.limit ? candidates.slice(0, params.limit) : candidates).map((r) => r.id);

  if (params.dryRun) {
    return res.status(200).json({
      dryRun: true,
      action: params.action,
      totalCandidates: candidates.length,
      totalSelected: modelIds.length,
      modelIds,
    });
  }

  let totalUpdated = 0;

  for (let i = 0; i < modelIds.length; i += params.batchSize) {
    const batch = modelIds.slice(i, i + params.batchSize);

    if (params.action === 'repair') {
      // Re-check the value in the UPDATE: a creator editing one of these between the read above and
      // this write has made a deliberate choice, and it must win over the repair.
      totalUpdated += await dbWrite.$executeRaw`
        UPDATE "Model"
        SET "allowCommercialUse" = ARRAY['Image', 'RentCivit', 'Rent', 'Sell']::"CommercialUse"[]
        WHERE id = ANY(${batch}::int[])
          AND "allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
      `;
    }

    await modelsSearchIndex.queueUpdate(
      batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );

    console.log(
      `backfill-trained-model-permissions (${params.action}): ` +
        `batch ${Math.floor(i / params.batchSize) + 1} — ${batch.length} models`
    );
  }

  res.status(200).json({
    dryRun: false,
    action: params.action,
    totalCandidates: candidates.length,
    totalSelected: modelIds.length,
    totalUpdated,
    modelIds,
  });
});
