import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelStatus, ModelType, ModelUploadType } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off. Grants `SellMerge` to models that carry `Sell` and predate the split.
 *
 * `CommercialUse.Sell` used to mean "sell this model or merges of it" — the checkbox read that way
 * and creators agreed to it as one term. The split into `Sell` and `SellMerge` left every legacy row
 * carrying only `Sell`, which now reads as withholding a permission its creator did grant.
 *
 * GET (dry run) / POST (live) /api/admin/temp/backfill-sell-merge-licence?token=<WEBHOOK_TOKEN>
 *   &dryRun=true|false   (default true; a live run must be POSTed)
 *   &batchSize=1500      (default 1500; max 2000)
 *   &afterId=<modelId>   (keyset resume; pass the previous response's nextAfterId)
 *
 * ONE batch per request, by design. The pace is an operational decision that depends on what the
 * models search index can absorb per 15-minute sync window, and an endpoint that looped internally
 * would bury that decision in a query parameter.
 *
 * `afterId` is load-bearing even though the predicate is self-consuming. A row the UPDATE declines
 * still matches the SELECT, so without the cursor a single declined row would head every subsequent
 * batch and the run would never advance past it.
 *
 * 🔴 The UPDATE deliberately does NOT touch `updatedAt`, unlike
 * `backfill-trained-model-permissions.ts` which bumps it for Published rows. Three reasons, and the
 * cost of the omission is stated below so whoever adds the line back knows what they are buying:
 *   - `updatedAt` is what the models index's delta scan selects on, so a bump would push all ~423k
 *     rows into that scan on top of the explicit enqueue below — the enqueue is what paces this run,
 *     and the bump would route the same ids in again by a path nothing here bounds.
 *   - `remove-old-drafts` hard-deletes Draft/Deleted models on `updatedAt < now() - 30 days`. A
 *     blanket bump defers that reaper by a month across every non-Published row in scope.
 *   - It is a creator-visible "last updated" signal, and this is not a creator edit.
 * What the omission costs: the per-batch `queueUpdate` becomes the ONLY route into the index, and
 * `addToQueue` fails open on a degraded sysRedis without propagating the failure. The backstop is
 * the full index reset that follows this backfill, plus `changedIds` in the response and the logs.
 *
 * The scope cutoff is the build timestamp of the image that opened the write paths (#4874). No pod
 * could serve the new build before its image existed, so a row untouched since then never met a form
 * offering the `SellMerge` checkbox and its missing member cannot be a decision. A row touched after
 * it has been through that form, so leaving the box unticked IS a decision and must survive this.
 * Erring early skips legacy rows; erring late overwrites a stated permission.
 *
 * Which is why `Sell` without `SellMerge` is a shape this backfill must leave behind rather than
 * eliminate: ticking `Sell` in `ModelUpsertForm` cascades in `RentCivit` and `Rent` but NOT
 * `SellMerge`, and the `SellMerge` box is never disabled, so a creator can grant one and decline the
 * other in a single click. A closing count above zero is that choice being honoured, not a short run.
 *
 * The cutoff is compared as an explicit `::timestamp` literal rather than a bound Date.
 * `Model."updatedAt"` is `timestamp(3)` without a zone, so a bound `timestamptz` parameter would be
 * rendered through the connection's TimeZone; the literal is read in the column's own terms.
 *
 * ⚠️ The UPDATE is raw SQL and writes no `diffEntityChanges` entry although `allowCommercialUse` is
 * a watched field, for the same reason as the sibling endpoint: 423k rows through the diffing path
 * to record one change they all share is not worth it. The response and the logs are the only record
 * of which licences moved. Keep them.
 */

const CUTOFF = '2026-09-17 03:11:25';

/**
 * The gate for this backfill is that the running build accepts `SellMerge` at `model.upsert`. Before
 * #4874 it did not, and the edit form resubmits a model's stored `allowCommercialUse` untouched — so
 * a backfilled row would have broken that creator's entire save, naming a permission with no
 * checkbox, while the raw-SQL backfill reported success.
 *
 * The probe runs the real `model.upsert` input schema, which is a fact about the build answering
 * this request. The Postgres enum label is NOT a substitute: it landed on 2026-09-15, a day before
 * the write paths opened, so it is true in both states this needs to tell apart.
 *
 * ⚠️ It speaks for one pod. It cannot see a half-rolled deploy where other pods still reject the
 * value, so it narrows the window rather than closing it — confirm the fleet is on one image too.
 *
 * Exported, and parameterised, so a test can hand it a contract that rejects the value and watch the
 * refusal fire. A guard whose failing path has never been executed is not known to have one.
 */
export function contractAcceptsSellMerge(
  contract: { safeParse: (value: unknown) => { success: boolean } } = modelUpsertSchema
) {
  return contract.safeParse({
    name: 'sell-merge write-path probe',
    type: ModelType.Checkpoint,
    uploadType: ModelUploadType.Created,
    status: ModelStatus.Draft,
    allowCommercialUse: ['Sell', 'SellMerge'],
  }).success;
}

const schema = z.object({
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(2000).default(1500),
  afterId: z.coerce.number().min(0).default(0),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  // A live run rewrites licence rows, and a GET is retried by proxies and prefetched by browsers off
  // a pasted URL. Dry runs stay readable from anywhere.
  if (!params.dryRun && req.method !== 'POST') {
    return res.status(405).json({ error: 'A live run must be POSTed' });
  }

  if (!params.dryRun && !contractAcceptsSellMerge()) {
    return res.status(409).json({
      error:
        'This build rejects SellMerge at model.upsert — backfilling now would break the next save ' +
        'of every model touched. Deploy the write paths (#4874) first.',
    });
  }

  const modelIds = (
    await dbRead.$queryRaw<{ id: number }[]>`
      SELECT m.id
      FROM "Model" m
      WHERE m."allowCommercialUse" @> ARRAY['Sell']::"CommercialUse"[]
        AND NOT (m."allowCommercialUse" @> ARRAY['SellMerge']::"CommercialUse"[])
        AND m."updatedAt" < ${CUTOFF}::timestamp
        AND m.id > ${params.afterId}
      ORDER BY m.id
      LIMIT ${params.batchSize}
    `
  ).map((r) => r.id);

  const lastId = modelIds.length ? modelIds[modelIds.length - 1] : params.afterId;
  // Short of a full batch means the scan reached the end of the table, not that the work is done:
  // rows whose `updatedAt` is past the cutoff are out of scope permanently and are never counted here.
  const exhausted = modelIds.length < params.batchSize;

  if (params.dryRun) {
    return res.status(200).json({
      dryRun: true,
      cutoff: CUTOFF,
      contractAcceptsSellMerge: contractAcceptsSellMerge(),
      afterId: params.afterId,
      totalSelected: modelIds.length,
      nextAfterId: lastId,
      exhausted,
      modelIds,
    });
  }

  // RETURNING, not a count, and the predicate re-checked here rather than only in the SELECT above:
  // a creator who edited one of these rows in between has made a deliberate choice and must win, and
  // a record naming a creator whose row never moved is worse than no record.
  const changed = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "allowCommercialUse" = m."allowCommercialUse" || ARRAY['SellMerge']::"CommercialUse"[]
    WHERE m.id = ANY(${modelIds}::int[])
      AND m."allowCommercialUse" @> ARRAY['Sell']::"CommercialUse"[]
      AND NOT (m."allowCommercialUse" @> ARRAY['SellMerge']::"CommercialUse"[])
      AND m."updatedAt" < ${CUTOFF}::timestamp
    RETURNING m.id
  `;

  const changedIds = changed.map((r) => r.id);

  if (changedIds.length) {
    await modelsSearchIndex.queueUpdate(
      changedIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  // Ids, not just a count: a mass licence change needs a record of which rows moved, and the run is
  // driven batch by batch from outside, so the log is where that record accumulates.
  console.log(
    `backfill-sell-merge-licence: afterId ${params.afterId} — ${changedIds.length} of ${
      modelIds.length
    } models — nextAfterId ${lastId} — ids ${changedIds.join(',')}`
  );

  res.status(200).json({
    dryRun: false,
    cutoff: CUTOFF,
    afterId: params.afterId,
    totalSelected: modelIds.length,
    totalChanged: changedIds.length,
    declinedIds: modelIds.filter((id) => !changedIds.includes(id)),
    nextAfterId: lastId,
    exhausted,
    changedIds,
  });
});
