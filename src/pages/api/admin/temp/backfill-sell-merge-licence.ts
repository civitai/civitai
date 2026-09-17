import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import {
  CommercialUse,
  ModelStatus,
  ModelType,
  ModelUploadType,
} from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off. Grants `SellMerge` to models that carry `Sell` and predate the split.
 *
 * `CommercialUse.Sell` used to mean "sell this model or merges of it" — the checkbox read that way
 * and creators agreed to it as one term. The split into `Sell` and `SellMerge` left every legacy row
 * carrying only `Sell`, which now reads as withholding a permission its creator did grant.
 *
 * GET (dry run) / POST (live) /api/admin/temp/backfill-sell-merge-licence?token=<WEBHOOK_TOKEN>
 *   &batchSize=<n>       (REQUIRED, no default — see below)
 *   &dryRun=true|false   (default true; a live run must be POSTed)
 *   &afterId=<modelId>   (keyset resume; pass the previous response's nextAfterId)
 *
 * ONE batch per request, and `batchSize` has no default on purpose. How fast this may run is an
 * operational question about what the models search index absorbs per sync window; it was once
 * answered with arithmetic that turned out to rest on a premise the code does not have, and a default
 * here would answer it again by omission, in the one place nobody re-reads. The caller states a
 * number. The `max` bounds a typo rather than recommending a size — it stops a mistyped parameter
 * becoming one statement over the whole population — and its value is arbitrary within an order of
 * magnitude. It deliberately is not `READ_BATCH_SIZE`'s 2,000, which would read as derived from the
 * retracted argument forever.
 *
 * `afterId` is load-bearing even though the predicate is self-consuming for rows the UPDATE ACCEPTS.
 * A row it declines still matches the SELECT, so without the cursor one declined row would head
 * every later batch and the run would never advance past it.
 *
 * 🔴 `exhausted: true` means THIS batch reached the end of the scan, not that the run is done — it is
 * only the latter if this call's `afterId` came from the previous response's `nextAfterId`. An
 * `afterId` mistyped past the id space returns `totalSelected: 0, exhausted: true` over an untouched
 * population, and no schema bound can tell that from a finished run. The operator's loop carries that
 * invariant; nothing here can.
 *
 * 🔴 The UPDATE deliberately does NOT touch `updatedAt`, unlike
 * `backfill-trained-model-permissions.ts`, which bumps it for Published rows. Three reasons:
 *   - `models.search-index.ts`'s delta scan selects on `status = 'Published' AND "updatedAt" >=
 *     lastUpdatedAt`, so a bump would route the Published share of ~422k rows into that scan on top
 *     of the explicit enqueue below, by a path nothing here bounds.
 *   - `remove-old-drafts` hard-deletes Draft/Deleted models on `updatedAt < now() - 30 days`, so a
 *     blanket bump defers that reaper by a month across every non-Published row in scope.
 *   - It is a creator-visible "last updated" signal, and this is not a creator edit.
 *
 * 🔴 What the omission costs, stated plainly because the index reset is NOT a backstop for it: the
 * per-batch `queueUpdate` is the only route into the index, `addToQueue` fails open (it parks the ids
 * in Postgres and returns false), and neither `SearchIndexUpdate.queueUpdate` nor
 * `modelsSearchIndex.queueUpdate` propagates that boolean — so this endpoint CANNOT DETECT a batch
 * whose enqueue was dropped, and answers 200 either way. The reset is an operational step this
 * endpoint cannot verify ran, and the plan keeps these enqueues precisely because a reset can die
 * against a backlog while still looking alive. Each covers the other's failure; neither is a backstop
 * for the other.
 *
 * THE SCOPE CUTOFF, and how to re-derive it rather than trust it. A row untouched since the moment
 * the `SellMerge` checkbox first reached a creator cannot have had it declined, so its missing member
 * is not a decision and this may grant it. A row touched after that has been through a form offering
 * the box, so leaving it unticked IS a decision and must survive this run.
 *
 * Erring early skips legacy rows; erring late overwrites a stated permission. That asymmetry is why
 * this edge is the earliest defensible one rather than the latest.
 *
 * `v5.1.103` (`a0cf2cceb6`, committed 2026-09-16 21:49:42Z) is the FIRST release containing #4874,
 * which opened the write paths — not `v5.1.105`, whose image timestamp (2026-09-17 03:11:25Z) was
 * originally taken for this edge and is 5h21m later. Prod serves tagged releases, so the relevant
 * commit is that tag's, not #4874's own merge commit (2026-09-16 19:10:43Z) — the merge is 2h39m
 * earlier and no build existed at it. Nothing can serve a release before its commit exists, so the
 * tag's commit time is the conservative edge, and it is re-derivable from `git log` by anyone without
 * a database query.
 *
 * The two cutoffs differ by 153 rows (prod REPLICA, `DATABASE_REPLICA_URL` on 25061, measured
 * 2026-09-17 from the primary checkout; 422,634 in scope at the old edge against 422,481 at this
 * one). Most of those are saves through a build that offered the checkbox; the ones closest to the
 * boundary may instead have been saved by v5.1.102 in the window between the tag and the roll, which
 * did not offer it. Those are legacy rows this run now skips — an under-grant, which is the safe
 * direction. The argument rests on the release ordering rather than on the count, so treat 153 as an
 * illustration that moves with organic churn rather than as a constant.
 *
 * The evidence that build was SERVING rather than merely tagged: model 2943312, a Trained upload, was
 * born 2026-09-16 22:13:58.728Z carrying `{Image,RentCivit,Rent,Sell,SellMerge}` with
 * `updatedAt == createdAt`. The training wizard sends no `allowCommercialUse`, so that array is the
 * running build's own Prisma default, which only #4874 introduced.
 *
 * The literal is UTC, and is compared as an explicit `::timestamp` cast rather than a bound Date:
 * `Model."updatedAt"` is `timestamp(3)` without a zone and Prisma writes it in UTC, so a bound
 * `timestamptz` would be rendered through the connection's TimeZone instead of read in the column's
 * own terms.
 *
 * `Sell` without `SellMerge` is a shape this run must LEAVE BEHIND rather than eliminate: ticking
 * `Sell` in `ModelUpsertForm` cascades in `RentCivit` and `Rent` but never `SellMerge`, and that box
 * is never disabled, so a creator can grant one and decline the other in a single click. A closing
 * count above zero is that choice being honoured, not a short run.
 *
 * ⚠️ The UPDATE is raw SQL and writes no `diffEntityChanges` entry although `allowCommercialUse` is a
 * watched field, for the same reason as the sibling endpoint: 422k rows through the diffing path to
 * record one change they all share is not worth it. The response and the logs are the only record of
 * which licences moved. Keep them.
 */

const CUTOFF = '2026-09-16 21:49:42';

/**
 * ONE predicate, interpolated into both the SELECT and the UPDATE. The endpoint's safety argument is
 * that the write's WHERE is identical to the read's — that is what makes a creator's mid-run edit win
 * — and two hand-written copies can be narrowed or widened one side at a time.
 */
const legacySellWithoutMerge = Prisma.sql`(
  m."allowCommercialUse" @> ARRAY['Sell']::"CommercialUse"[]
  AND NOT (m."allowCommercialUse" @> ARRAY['SellMerge']::"CommercialUse"[])
  AND m."updatedAt" < ${CUTOFF}::timestamp
)`;

export const WRITE_PATH_PROBE = {
  name: 'sell-merge write-path probe',
  type: ModelType.Checkpoint,
  uploadType: ModelUploadType.Created,
  status: ModelStatus.Draft,
  allowCommercialUse: [CommercialUse.Sell, CommercialUse.SellMerge],
};

/**
 * The gate for this backfill is that the running build accepts `SellMerge` at `model.upsert`. Before
 * #4874 it did not, and the edit form resubmits a model's stored `allowCommercialUse` untouched — so
 * a backfilled row would have broken that creator's entire save, naming a permission with no
 * checkbox, while the raw-SQL backfill reported success.
 *
 * It asserts the member SURVIVES parsing rather than that the payload parses. A future hold-back
 * implemented as a strip inside `licensingSchema`'s existing `.preprocess`, rather than as the
 * `.refine` #4874 deleted, would parse cleanly with `SellMerge` silently removed — and a `.success`
 * check would read that as the write paths being open while every creator's next save quietly
 * reverted the member. Reading the parsed output also survives the enum itself being loosened.
 *
 * The probe runs the real `model.upsert` input schema, so it is a fact about the build answering this
 * request. The Postgres enum label is NOT a substitute: it landed 2026-09-15, a day before the write
 * paths opened, so it is true in both states this has to tell apart.
 *
 * ⚠️ It speaks for ONE POD. It cannot see a half-rolled deploy where other pods still reject the
 * value, so it narrows the window rather than closing it — confirm the fleet is on one image too.
 *
 * Exported and parameterised so a test can hand it a contract that rejects the value, and one that
 * strips it, and watch the refusal fire. A guard whose failing path has never been executed is not
 * known to have one.
 */
export function contractAcceptsSellMerge(
  contract: {
    safeParse: (value: unknown) => { success: boolean; data?: { allowCommercialUse?: unknown } };
  } = modelUpsertSchema
) {
  const parsed = contract.safeParse(WRITE_PATH_PROBE);
  if (!parsed.success) return false;

  const allowed = parsed.data?.allowCommercialUse;
  return Array.isArray(allowed) && allowed.includes(CommercialUse.SellMerge);
}

const schema = z.object({
  dryRun: booleanString().default(true),
  // `.int()` on both because a fractional value reaches Postgres as a fractional LIMIT or comparand,
  // which the Prisma engine rounds (measured: `LIMIT 2.5` returns 3 rows) while node-postgres rejects
  // outright. Rounding DOWN would make `exhausted` true with the population untouched.
  batchSize: z.coerce.number().int().min(1).max(5000),
  afterId: z.coerce.number().int().min(0).default(0),
});

export default WebhookEndpoint(async (req, res) => {
  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success) {
    return res.status(400).json({
      error:
        'batchSize is required and has no default — the pace of this run is an operational decision, ' +
        'not something this endpoint answers by omission. Pass 1..5000.',
      issues: parsedParams.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  const params = parsedParams.data;

  // A live run rewrites licence rows, and a GET is retried by proxies and prefetched by browsers off
  // a pasted URL. Dry runs stay readable from anywhere.
  if (!params.dryRun && req.method !== 'POST') {
    return res.status(405).json({ error: 'A live run must be POSTed' });
  }

  if (!params.dryRun && !contractAcceptsSellMerge()) {
    return res.status(409).json({
      error:
        'This build does not keep SellMerge through model.upsert — backfilling now would break or ' +
        'silently revert the next save of every model touched. Deploy the write paths (#4874) first.',
    });
  }

  const modelIds = (
    await dbRead.$queryRaw<{ id: number }[]>`
      SELECT m.id
      FROM "Model" m
      WHERE ${legacySellWithoutMerge}
        AND m.id > ${params.afterId}
      ORDER BY m.id
      LIMIT ${params.batchSize}
    `
  ).map((r) => r.id);

  const lastId = modelIds.length ? modelIds[modelIds.length - 1] : params.afterId;
  // Short of a full batch means the scan reached the end of the table, not that no work remains:
  // rows whose `updatedAt` is past the cutoff are out of scope permanently and never counted here.
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

  // The terminal live call selects nothing, and `id = ANY('{}')` is a pointless round-trip whose
  // empty-array parameter is the shape most likely to trip raw-parameter serialisation — on the one
  // call that is supposed to report `exhausted: true`, so a throw there would read as the run failing
  // at the moment it finished.
  if (!modelIds.length) {
    return res.status(200).json({
      dryRun: false,
      cutoff: CUTOFF,
      afterId: params.afterId,
      totalSelected: 0,
      totalChanged: 0,
      declinedIds: [],
      nextAfterId: lastId,
      exhausted: true,
      changedIds: [],
    });
  }

  // RETURNING, not a count, and the predicate re-checked here rather than only in the SELECT above:
  // a creator who edited one of these rows in between has made a deliberate choice and must win, and
  // a record naming a creator whose row never moved is worse than no record.
  const changed = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "Model" m
    SET "allowCommercialUse" = m."allowCommercialUse" || ARRAY['SellMerge']::"CommercialUse"[]
    WHERE m.id = ANY(${modelIds}::int[])
      AND ${legacySellWithoutMerge}
    RETURNING m.id
  `;

  const changedIds = changed.map((r) => r.id);
  const changedSet = new Set(changedIds);

  // Logged BEFORE the enqueue: the rows have already moved, so an enqueue that rejects would
  // otherwise take the only record of which licences changed down with it.
  console.log(
    `backfill-sell-merge-licence: afterId ${params.afterId} — ${changedIds.length} of ${
      modelIds.length
    } models — nextAfterId ${lastId} — ids ${changedIds.join(',')}`
  );

  if (changedIds.length) {
    await modelsSearchIndex.queueUpdate(
      changedIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  res.status(200).json({
    dryRun: false,
    cutoff: CUTOFF,
    afterId: params.afterId,
    totalSelected: modelIds.length,
    totalChanged: changedIds.length,
    declinedIds: modelIds.filter((id) => !changedSet.has(id)),
    nextAfterId: lastId,
    exhausted,
    changedIds,
  });
});
