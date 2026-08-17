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
 * Created-uploadType models with the same value are left alone: nothing rules out an API client
 * having set them deliberately, and no mechanism is known that would produce `{Sell}` on them by
 * accident.
 *
 * ⚠️ That argument is not airtight for Trained uploads either, and the asymmetry is deliberate
 * rather than overlooked. The cascade lives only in the form's `onChange`; `licensingSchema` and
 * `upsertModel` apply none server-side, so an owner who posts `allowCommercialUse: ['Sell']`
 * directly is indistinguishable from a defaulted row and gets widened against their intent. The
 * difference is that on Trained uploads a mechanism is demonstrated - the wizard sends no field at
 * all - and it accounts for the whole population, while on Created uploads there is none. Repairing
 * a deliberate API write would be wrong; the judgement is that it is rare against 121k defaulted
 * rows, and the changed ids are recorded so it can be undone per model.
 *
 * ⚠️ The candidate set spans every status, not only Published — on the prod replica 121,754 rows
 * excluding Deleted, of which 65,974 are Published and the rest Draft / Unpublished /
 * UnpublishedViolation / Scheduled / Training, plus ~25k Deleted. Removed and deleted models are
 * included on purpose: `restoreModelById` un-deletes, and a restored model must not come back
 * carrying a licence its creator never set and no Create button to go with it.
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
 * GET (dry run) / POST (live) /api/admin/temp/backfill-trained-model-permissions?token=<WEBHOOK_TOKEN>
 *   &action=repair|reindex   (default repair)
 *   &dryRun=true|false       (default true; a live run must be POSTed)
 *   &batchSize=1000          (default 1000; max 2000)
 *   &limit=<n>               (optional; bound a first run to prove the shape)
 *   &afterId=<modelId>       (optional; resume after this id)
 *
 * Side effects when dryRun=false:
 *   - repair:  UPDATE Model.allowCommercialUse to [Image, RentCivit, Rent, Sell] for matched rows,
 *              and queue modelsSearchIndex updates for them.
 *   - reindex: queue modelsSearchIndex updates only.
 *
 * A live response returns `changedIds` — the rows the UPDATE actually moved, via RETURNING, not the
 * ids attempted — and each batch logs the same plus its `lastId`. A mass licence change needs a
 * record of which rows moved, and a run this long can outlive the request.
 * `limit` alone only chunks `repair`, which is self-consuming (a repaired row stops matching);
 * `reindex` is not, so chunking it needs `afterId` from the previous batch's `lastId`.
 *
 * `reindex` refuses with 409 while the old view is still in place, rather than trusting the runbook:
 * run early, the sync job recomputes canGenerate from the old view and writes back the `true` this
 * is meant to clear.
 *
 * ⚠️ The UPDATE is raw SQL and so writes no `diffEntityChanges` entry, though `allowCommercialUse`
 * is a watched field. That is deliberate — routing 121k rows through the diffing path to record a
 * change every row shares is not worth it — but it means the response and these logs are the only
 * record if a creator later disputes that their licence changed. Keep them.
 */

/** b5455112c2 — before this, a bare {Sell} was reachable through the form and meant it. */
const CASCADE_LANDED_AT = new Date('2024-06-11T00:00:00Z');

const schema = z.object({
  action: z.enum(['repair', 'reindex']).default('repair'),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(2000).default(1000),
  limit: z.coerce.number().min(1).optional(),
  afterId: z.coerce.number().min(0).default(0),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  // A live run rewrites six figures of licence rows, and a GET is retried by proxies and prefetched
  // by browsers off a pasted URL. Dry runs stay readable from anywhere.
  if (!params.dryRun && req.method !== 'POST') {
    return res.status(405).json({ error: 'A live run must be POSTed' });
  }

  const candidates =
    params.action === 'repair'
      ? await dbRead.$queryRaw<{ id: number }[]>`
          SELECT m.id
          FROM "Model" m
          WHERE m."uploadType" = 'Trained'
            AND m."allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
            AND m."createdAt" >= ${CASCADE_LANDED_AT}
            AND m.id > ${params.afterId}
          ORDER BY m.id
        `
      : await dbRead.$queryRaw<{ id: number }[]>`
          SELECT m.id
          FROM "Model" m
          WHERE NOT (m."allowCommercialUse" && ARRAY['RentCivit']::"CommercialUse"[])
            AND m."allowCommercialUse" && ARRAY['Rent', 'Sell']::"CommercialUse"[]
            AND m.status != 'Deleted'
            AND m.id > ${params.afterId}
          ORDER BY m.id
        `;

  // Run before the view is replaced and this is worse than useless: the sync job recomputes
  // canGenerate from the OLD view, writes back the `true` it is meant to clear, and drops the queue
  // entry - so the models are never re-queued and stay listed under the on-site-generation filter.
  // Ask the view itself whether it has been replaced yet rather than trusting the runbook.
  if (params.action === 'reindex') {
    const [stale] = await dbRead.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one
      FROM "GenerationCoverage" gc
      JOIN "Model" m ON m.id = gc."modelId"
      WHERE gc.covered
        AND NOT (m."allowCommercialUse" && ARRAY['RentCivit']::"CommercialUse"[])
        AND m."allowCommercialUse" && ARRAY['Rent', 'Sell']::"CommercialUse"[]
      LIMIT 1
    `;
    if (stale) {
      return res.status(409).json({
        error:
          'GenerationCoverage still grants coverage without RentCivit — apply the migration first, ' +
          'then reindex. Running now would re-write canGenerate: true from the old view.',
      });
    }
  }

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

  const changedIds: number[] = [];

  for (let i = 0; i < modelIds.length; i += params.batchSize) {
    const batch = modelIds.slice(i, i + params.batchSize);

    // RETURNING, not a count: the re-checked WHERE means the ids attempted are not the ids changed,
    // and a record that names a creator whose row never moved is worse than no record.
    // Re-checking is the point — a creator editing one of these between the read above and this
    // write has made a deliberate choice, and it must win over the repair.
    const changed =
      params.action === 'repair'
        ? await dbWrite.$queryRaw<{ id: number }[]>`
            UPDATE "Model"
            SET "allowCommercialUse" = ARRAY['Image', 'RentCivit', 'Rent', 'Sell']::"CommercialUse"[]
            WHERE id = ANY(${batch}::int[])
              AND "allowCommercialUse" = ARRAY['Sell']::"CommercialUse"[]
            RETURNING id
          `
        : batch.map((id) => ({ id }));

    const changedBatch = changed.map((r) => r.id);
    changedIds.push(...changedBatch);

    if (changedBatch.length) {
      await modelsSearchIndex.queueUpdate(
        changedBatch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }

    // Ids per batch, not just a count: a run long enough to outlive the ingress timeout returns
    // nothing, and then the log is the only record of which licences moved.
    console.log(
      `backfill-trained-model-permissions (${params.action}): ` +
        `batch ${Math.floor(i / params.batchSize) + 1} — ${changedBatch.length} of ${
          batch.length
        } models — lastId ${batch[batch.length - 1]} — ids ${changedBatch.join(',')}`
    );
  }

  res.status(200).json({
    dryRun: false,
    action: params.action,
    totalCandidates: candidates.length,
    totalSelected: modelIds.length,
    totalChanged: changedIds.length,
    changedIds,
  });
});
