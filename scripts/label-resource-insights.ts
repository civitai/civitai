import { createHash } from 'crypto';
import { parseArgs } from 'util';

import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { modelsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import {
  askJev,
  JEV_TIMEOUT_MS,
  jevConfidenceFloor,
  type JevQuestionSpec,
} from '~/server/services/ai/jev';
import {
  RESOURCE_INTENT_CONTENT_TYPE_OPTIONS,
  RESOURCE_INTENT_ROLE_OPTIONS,
  RESOURCE_INTENT_STYLE_FAMILY_OPTIONS,
  type ResourceIntentContentType,
  type ResourceIntentRole,
  type ResourceIntentStyleFamily,
} from '~/server/schema/resource-intent.schema';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { Availability } from '~/shared/utils/prisma/enums';
import { drainStdio, runScriptAndExit } from './lib/run-as-script';

/**
 * ResourceInsight labeling pass (M2) — batch-labels PUBLISHED model versions
 * with what each resource is FOR (role / styleFamily / contentTypes /
 * qualityScore), via the Jev judgment model.
 *
 * Usage:
 *   pnpm run tsscript scripts/label-resource-insights.ts                # dry run (default)
 *   pnpm run tsscript scripts/label-resource-insights.ts --execute      # write rows
 *   pnpm run tsscript scripts/label-resource-insights.ts --limit 1000   # cap versions
 *   pnpm run tsscript scripts/label-resource-insights.ts --cursor 12345 # resume after id
 *   pnpm run tsscript scripts/label-resource-insights.ts --top 10000    # highest-usage N only
 *
 * `dry run` IS NOT A NO-OP, and it is NOT RUNNABLE BEFORE THE MIGRATION IS
 * APPLIED. Two independent facts, both load-bearing:
 *
 *   1. A dry run still issues the full vendor request. `labelBatch` calls
 *      `askJev` unconditionally; `dryRun` gates only the `dbWrite` upsert. So a
 *      dry run costs the same vendor spend as `--execute` and only withholds
 *      the rows.
 *   2. Without `--force`, every page reads `dbRead.resourceInsight.findMany` to
 *      skip already-current rows. That read throws while the `ResourceInsight`
 *      table does not exist, and it runs BEFORE the first `askJev` call — so
 *      the default no-flag invocation fails fast pre-migration. `--force` is
 *      the only flag that skips that read, and it therefore makes a
 *      pre-migration dry run possible AND makes it spend vendor budget on the
 *      first batch.
 *
 * Apply the migration to the target environment first (nothing auto-applies
 * it); treat any invocation, dry run included, as a spend decision.
 *
 * A REAL RUN ALSO ANNOUNCES ITS WRITES TO THE MODELS SEARCH INDEX, because the
 * incremental sync cannot see a `ResourceInsight` write. A model enters that
 * sync on exactly three conditions, and they live in TWO files: `Model.createdAt
 * >= lastUpdatedAt` and `Model.updatedAt >= lastUpdatedAt` are in
 * `prepareModelsBatches` (src/server/search-index/models.search-index.ts), and
 * the third — the index's own update queue — is read by the shared processor's
 * `update()` in src/server/search-index/base.search-index.ts, which unions the
 * queued ids with that function's `updateIds`. Do not go looking for all three
 * in one place. A label row satisfies none of them: it touches neither `Model`
 * column. So every batch that writes rows enqueues the affected MODEL ids
 * (deduplicated; `ResourceInsight` is per version while the index is per model).
 * Without it, any insight attribute served from the index stays frozen at the
 * last manual full re-projection. `--execute` only: a dry run writes nothing and
 * so has nothing to announce.
 *
 * 🔴 `queued N` COUNTS ANNOUNCEMENTS ISSUED, NOT ANNOUNCEMENTS LANDED, and the
 * difference is not pedantry: `addToQueue` fails open on a degraded sysRedis —
 * it parks the ids in Postgres for `search-index-queue-drain` and returns
 * `false` — and `modelsSearchIndex.queueUpdate` does not propagate that
 * boolean (stated at
 * src/pages/api/admin/temp/queue-paid-models-reindex.ts). So the counter is
 * identical on a healthy run and on a run whose every enqueue was parked.
 *
 * So a real run that announces anything READS THE QUEUE BACK ONCE, after the
 * first batch that enqueues (a run whose every candidate is skipped as
 * already-current, or whose answers never map, announces nothing and therefore
 * prints no `queue-verify:` line at all),
 * and prints `queue-verify: …`. Not a flag and not per batch: not a flag because
 * an opt-in check is one nobody remembers to pass, and not per batch because
 * this queue reaches hundreds of thousands of ids on a large fan-out and
 * scanning it per batch is itself a hazard. The result is ONE-DIRECTIONAL, like
 * the equivalent read-back in the admin endpoint above, and WEAKER than "proof"
 * in BOTH directions — do not report it as either. Not finding the ids is
 * inconclusive: the 15-minute sync may have checked the queue out in between.
 * Finding them is CORROBORATION, not proof, because the queue is SHARED — many
 * other call sites across the codebase call `modelsSearchIndex.queueUpdate`,
 * and an entry survives until the next non-`readOnly` checkout — so a
 * model that some unrelated edit queued minutes ago is present regardless of
 * what this run did.
 * The case that makes the distinction real: a first batch mapping to one model,
 * a sysRedis that fails open on every enqueue (parking ids in Postgres), and
 * that one model independently edited a few minutes earlier — `found ===
 * modelIds.length` holds and every announcement in the run was in fact parked.
 * See `verifyFirstEnqueue`.
 *
 * ⚠️ THE PROCESS CANNOT EXIT ON ITS OWN ANY MORE. Importing
 * `~/server/search-index` reaches `~/server/redis/caches` → `~/server/redis/
 * client`, which CONSTRUCTS AND CONNECTS both redis clients at module load and
 * arms a ping interval. Open sockets plus a live timer hold the event loop, so
 * the tail guard below exits explicitly once `main()` resolves — the same thing
 * scripts/seed-scanner-policies.ts does, and for the same reason. Without it a
 * finished run prints its summary and then hangs, which reads as a stalled
 * batch and makes any wrapper (a cron, a `timeout`) report failure on a run that
 * fully succeeded. Narrowing the import does not help: the models index module
 * pulls in the same cache module.
 *
 * Spend is REPORTED, not estimated: each progress line and the final summary
 * carry `spent=$…`, accumulated from the vendor's own per-request cost. A batch
 * whose response carried no cost is counted as `unreported` rather than folded
 * in as zero, so the total always says how much of the run it covers.
 *
 * The corpus is ~975k published versions; the binding constraint is the vendor
 * throughput cap, so resources are labeled in SHARED REQUESTS of
 * LABEL_BATCH_SIZE versions each (one round trip, per-resource questions with
 * stable `r<idx>.<question>` ids). The fleet run is a gated follow-up — apply
 * the migration to the target environment first (nothing auto-applies it).
 *
 * TWO SELECTION PATHS, and the default one is the fleet run:
 *
 *   DEFAULT (no `--top`) — keyset over the whole corpus (`id > cursor ORDER BY
 *   id`): a version created mid-run cannot shift a page out from under the scan,
 *   because the ordering is immutable. Resume with the last `cursor=N` printed.
 *
 *   `--top N` — only the N highest-usage versions, for bounding vendor spend
 *   during a validation phase. Opt-in and off by default; omitting it leaves
 *   the keyset path untouched. The ids are materialised ONCE up front (see
 *   `topUsageVersionIds` for why pagination over a mutable metric is unsafe),
 *   so here `--cursor` is an INDEX into that fixed list rather than a version
 *   id, and the script prints `index=N` instead of `cursor=N` to match.
 *
 * KNOWN LIMITATION — `parseLabelAnswers` isolates per-resource failures, but
 * `askJev` cannot currently reach that path, so the isolation does not hold
 * end to end. `askJev` builds its answer list by mapping over the questions it
 * SENT and calling `parseAnswer(question, …)`, which takes the answer's `type`
 * from the question spec and throws `JevError('malformed')` on a missing or
 * unparseable answer. So a malformed answer for one resource aborts the whole
 * request: the error surfaces in `main`'s per-batch `catch`, which counts all
 * LABEL_BATCH_SIZE versions failed. `failedVersionIds` is therefore reachable
 * from a direct call but not from a real vendor round trip. Making the
 * isolation real means splitting or retrying per resource inside the batch —
 * a change deliberately NOT made here, so that this port stays a port.
 */

export const LABEL_BATCH_SIZE = 10;
export const LABEL_DESCRIPTION_MAX_CHARS = 300;
export const LABEL_TRAINED_WORDS_MAX = 8;

// The labeling instrument is its OWN question set (resource-side wording), so
// it carries its own spec hash — a label row's specHash says which LABEL spec
// judged it, not which stage-1 spec did. IDs stable once shipped.

/**
 * The `quality` rubric: one labelled point per step of the declared 1–10 range.
 *
 * These strings are the only thing the vendor is told about the scale — the wire
 * carries `criteria` and nothing else, and the score comes back in index space —
 * so they are not documentation, they ARE the definition of what the number
 * means. Written as a graded progression rather than ten rephrasings of "good",
 * because an undifferentiated rubric gives the model no basis to separate
 * adjacent points and the resulting score carries correspondingly less signal.
 *
 * The axis is deliberately "how well does the metadata evidence this resource
 * serving the role it was just assigned" — not popularity, not aesthetics,
 * neither of which is visible in what the batch sends.
 */
export const LABEL_QUALITY_CRITERIA = [
  'Unusable for this role: the metadata describes something unrelated to it, or is too sparse to support any judgment.',
  'Barely relevant: generic or boilerplate description, with nothing indicating the resource was built for this role.',
  'Weak fit: the resource touches the role only incidentally, and nothing suggests it performs it well.',
  'Below average: plausibly usable for the role, but the metadata leaves its scope or its output vague.',
  'Adequate: clearly intended for the role, with enough detail to use it, and no indication of particular strength.',
  'Solid: purpose-built for the role, with a stated scope and trigger words consistent with it.',
  'Good: specific and well scoped, and the metadata gives concrete guidance on when the resource applies.',
  'Strong: focused, with a clear range of application, documented triggers, and an unambiguous intended output.',
  'Excellent: precise scope, a base model suited to the role, and documentation detailed enough to use it correctly first time.',
  'Exemplary: the reference standard for this role — unmistakable purpose, complete and specific metadata, nothing left for the user to guess.',
] as const;

export const LABEL_QUESTION_SPEC = [
  {
    id: 'role',
    type: 'choice',
    prompt: 'In a generation, what role would this resource play?',
    options: RESOURCE_INTENT_ROLE_OPTIONS,
  },
  {
    id: 'styleFamily',
    type: 'choice',
    prompt: 'Which style family does this resource belong to?',
    options: RESOURCE_INTENT_STYLE_FAMILY_OPTIONS,
  },
  {
    id: 'contentType',
    type: 'choice',
    prompt: 'Which content type does this resource primarily serve?',
    options: RESOURCE_INTENT_CONTENT_TYPE_OPTIONS,
  },
  {
    id: 'quality',
    type: 'score',
    // No numeric scale in the wording: the vendor is sent ONLY `criteria` and
    // answers in index space, so a prompt asserting "1 = poor, 10 = exemplary"
    // would describe a numbering it never sees. The rubric below IS the scale.
    prompt: 'Judging only from this metadata, how well does this resource serve that role?',
    min: 1,
    max: 10,
    // One labelled scale point per step from `min` to `max` inclusive, so
    // exactly 10. `askJev` refuses the request when `criteria.length` and
    // `max - min + 1` disagree, because the vendor scores in index space and is
    // never told the range — a mismatch silently rescales every answer rather
    // than failing. Pinned by a test; see LABEL_QUALITY_CRITERIA below.
    criteria: LABEL_QUALITY_CRITERIA,
    // 🔴 Deliberately NOT `integer: true`. `ResourceInsight.qualityScore` is
    // DOUBLE PRECISION, so the model's fractional confidence-weighted score is
    // worth keeping — rounding it here would throw away precision the column
    // can hold. (Contrast stage-1's `specificity`, whose consumer is a
    // `z.number().int()` schema and which therefore does round.)
  },
] as const satisfies readonly JevQuestionSpec[];

export const LABEL_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(LABEL_QUESTION_SPEC))
  .digest('hex');

/**
 * The corpus predicate — WHICH model versions this pass is allowed to label.
 *
 * 🔴 ONE DEFINITION, USED BY EVERY SELECTION PATH. This rule is spelled in
 * three places across the feature (here, and in the serving-side matcher at
 * src/server/services/resource-intent-matcher.service.ts), and it is exactly
 * how the two came to disagree: this pass had drifted to excluding
 * `Unsearchable`, which means "public but kept out of search results" (see the
 * enum's own comment in packages/civitai-db-schema/prisma/schema.full.prisma),
 * so it dropped public resources while still admitting private ones. Do not
 * open-code these clauses at a call site; spread this object instead, and do
 * not add a narrowing clause AFTER the spread, which would silently override it.
 *
 * Both the version's own availability and its parent model's are checked:
 * either one being Private must keep the row out, and the two are independent
 * columns, so both mixed combinations occur in practice.
 */
export const LABELABLE_VERSION_FILTER = {
  status: 'Published',
  availability: { not: Availability.Private },
  model: { status: 'Published', availability: { not: Availability.Private } },
} as const;

/**
 * The columns a label judgment is derived from. Shared by both selection paths.
 *
 * `modelId` is NOT a judgment input — nothing in the batch request sees it. It is
 * selected because a written label has to be announced to the MODELS search
 * index, which is keyed per model while `ResourceInsight` is keyed per model
 * version. Reading the parent id off the row that is already being fetched is
 * what keeps that mapping free; resolving it afterwards would be a second query
 * per batch for a column the first query could have returned.
 */
export const LABELABLE_VERSION_SELECT = {
  id: true,
  modelId: true,
  name: true,
  baseModel: true,
  trainedWords: true,
  description: true,
  model: { select: { type: true, nsfw: true } },
} as const;

export type LabelableVersion = {
  id: number;
  modelId: number;
  name: string;
  baseModel: string;
  trainedWords: string[];
  description: string | null;
  model: { type: string; nsfw: boolean };
};

export type ResourceInsightLabel = {
  modelVersionId: number;
  role: ResourceIntentRole;
  styleFamily: ResourceIntentStyleFamily;
  contentTypes: ResourceIntentContentType[];
  qualityScore: number;
  confidence: number;
  specHash: string;
  model: string;
};

/** What a parsed vendor response yields, before anything is written or announced. */
export type LabelParseResult = {
  labels: ResourceInsightLabel[];
  failedVersionIds: number[];
};

export type LabelBatchResult = LabelParseResult & {
  /**
   * The VENDOR'S OWN reported spend for this batch's one request, straight from
   * the decisions response — never derived from a token count and a price
   * table, which is how a cost report drifts from the invoice.
   *
   * `undefined` means the response carried no `cost`, which is why the run
   * counts unreported batches separately instead of folding them in as zero: a
   * total that silently treats "not reported" as "free" understates spend, and
   * understating is the direction that matters when the number exists to bound
   * a budget.
   */
  costUsd?: number;
  /**
   * The model ids this batch HANDED TO the models search-index queue API —
   * empty on a dry run (nothing was written, so there is nothing to re-index)
   * and empty when that call threw.
   *
   * ⚠️ "Handed to" is the honest verb, not "landed". `queueUpdate` returns
   * `void`: underneath it `addToQueue` is deadline-raced and fail-open, and a
   * dropped id goes to a Postgres parking lot replayed by the
   * `search-index-queue-drain` job rather than coming back as an error. So a
   * non-zero count here says the announcement was issued and is recoverable by
   * the platform, not that redis accepted it.
   */
  enqueuedModelIds: number[];
};

function resourceQuestionId(versionIndex: number, questionId: string): string {
  return `r${versionIndex}.${questionId}`;
}

/** The shared batch request: one question set PER RESOURCE, ids namespaced by index. */
export function buildLabelQuestions(versions: LabelableVersion[]): {
  questions: JevQuestionSpec[];
  state: Record<string, string>;
} {
  const questions = versions.flatMap((_, index) =>
    LABEL_QUESTION_SPEC.map((question): JevQuestionSpec => {
      const prompt = `Resource ${index}: ${question.prompt}`;
      if (question.type === 'choice') {
        return {
          id: resourceQuestionId(index, question.id),
          type: 'choice',
          prompt,
          options: [...question.options],
        };
      }
      return {
        id: resourceQuestionId(index, question.id),
        type: 'score',
        prompt,
        min: question.min,
        max: question.max,
        // Carried through per resource, not rebuilt: `criteria.length` must keep
        // matching `max - min + 1` here too, and the spec is the one place that
        // pairing is declared. `integer` is intentionally not set — see the spec.
        criteria: [...question.criteria],
      };
    })
  );
  // State carries ONLY the resource's own metadata — nothing else, so one
  // resource cannot distract the judgments of its batch neighbors.
  const state: Record<string, string> = {};
  versions.forEach((version, index) => {
    state[`resource${index}`] = JSON.stringify({
      name: version.name,
      type: version.model.type,
      baseModel: version.baseModel,
      trainedWords: version.trainedWords.slice(0, LABEL_TRAINED_WORDS_MAX),
      description: (version.description ?? '').slice(0, LABEL_DESCRIPTION_MAX_CHARS),
    });
  });
  return { questions, state };
}

/** Map validated Jev answers to labels; a resource whose answers don't map is skipped, not fatal. */
export function parseLabelAnswers(
  versions: LabelableVersion[],
  answers: Awaited<ReturnType<typeof askJev>>['answers']
): LabelParseResult {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const labels: ResourceInsightLabel[] = [];
  const failedVersionIds: number[] = [];

  versions.forEach((version, index) => {
    const role = byId.get(resourceQuestionId(index, 'role'));
    const styleFamily = byId.get(resourceQuestionId(index, 'styleFamily'));
    const contentType = byId.get(resourceQuestionId(index, 'contentType'));
    const quality = byId.get(resourceQuestionId(index, 'quality'));
    if (
      role?.type !== 'choice' ||
      styleFamily?.type !== 'choice' ||
      contentType?.type !== 'choice' ||
      quality?.type !== 'score'
    ) {
      failedVersionIds.push(version.id);
      return;
    }
    // The row's confidence is the WEAKEST of its four judgments, because the
    // weakest one bounds what the row as a whole is worth: a confident role
    // paired with a coin-flip style family is not a confident label.
    //
    // 🔴 Via the shared helper, never open-coded. It skips `noul` answers,
    // which carry no confidence at all, and skips a missing one rather than
    // defaulting it — an earlier revision here read `role.confidence ?? 0`,
    // which both ignored three of the four answers AND would pin the column to
    // 0 for any answer set the vendor returned without a confidence. This is
    // the third place in this feature that would have spelled the same rule,
    // and the previous two disagreed with each other.
    const confidence = jevConfidenceFloor([role, styleFamily, contentType, quality]);
    if (confidence === null) {
      // No answer carried a confidence, so there is no floor to record.
      // `ResourceInsight.confidence` is NOT NULL, and inventing a number for a
      // column whose entire purpose is to say how much to trust the row is
      // worse than declining the resource — so it fails, like any other
      // unmappable answer set, and stays available for a later re-label.
      failedVersionIds.push(version.id);
      return;
    }
    // askJev already validated each value against the question it was asked;
    // these casts carry that proof into the typed columns.
    labels.push({
      modelVersionId: version.id,
      role: role.value as ResourceIntentRole,
      styleFamily: styleFamily.value as ResourceIntentStyleFamily,
      // v1 records a single primary content type; the column is an array so a
      // future spec can ask for the full set without a migration.
      contentTypes: [contentType.value as ResourceIntentContentType],
      qualityScore: quality.value / 10,
      confidence,
      specHash: LABEL_SPEC_HASH,
      model: 'typesafe/jev-1.13',
    });
  });

  return { labels, failedVersionIds };
}

/**
 * Whether an existing row must be re-labeled: anything written under a
 * different label spec is stale, whatever its current values look like.
 */
export function isLabelStale(
  existing: { specHash: string; stale: boolean } | null | undefined,
  specHash: string
): boolean {
  if (!existing) return false;
  return existing.stale || existing.specHash !== specHash;
}

/**
 * Split a fetched page into the versions that need a label (new or stale under
 * `specHash`) and the ones whose stored row is already current. Skips are the
 * throughput win on resume runs — a full corpus re-label costs vendor spend
 * and hours of the 1,200 req/min budget for identical answers.
 */
export function partitionNeedingLabel(
  versions: LabelableVersion[],
  existingRows: { modelVersionId: number; specHash: string; stale: boolean }[],
  specHash: string
): { toLabel: LabelableVersion[]; skipped: number } {
  const byId = new Map(existingRows.map((row) => [row.modelVersionId, row]));
  const toLabel = versions.filter((version) => {
    const existing = byId.get(version.id);
    // No row yet = unlabeled = needs a label; a row under a different (or
    // stale-marked) spec needs a re-label. Only a current row is skipped.
    return !existing || isLabelStale(existing, specHash);
  });
  return { toLabel, skipped: versions.length - toLabel.length };
}

/**
 * The DISTINCT parent model ids of the versions a batch actually labeled.
 *
 * Two translations, both load-bearing, which is why this is a named function
 * rather than an inline `map` at the call site:
 *
 *   1. VERSION → MODEL. `ResourceInsight` is keyed on `modelVersionId`; the
 *      models search index is keyed on the MODEL. Enqueuing version ids would
 *      queue ids that are valid-looking integers in the wrong id space — the
 *      queue is a bare list of numbers and cannot reject them — so the pass
 *      would re-index whichever unrelated models happened to share those ids.
 *   2. DEDUPLICATE. The raw mapping can repeat ids. ⚠️ How often depends on the
 *      selection path, and the honest answer is "rarely, on the default one":
 *      under `--top` usage correlates within a model so a batch really can hold
 *      several of its versions, but the default sweep walks version ids in
 *      order and a model's versions are created at different times, so they are
 *      not adjacent — expect near-zero collapse there, i.e. roughly one model
 *      enqueued per version labeled. ⚠️ This is NOT load-bearing
 *      for correctness or for index cost, and saying otherwise is how a false
 *      claim about the queue gets propagated: the queue is a redis SET
 *      (`sAdd`), `checkoutQueue` collects into a `Set`, and
 *      `src/server/services/model.service.ts` states the policy outright —
 *      "a duplicate enqueue is free: processQueues dedupes with a Set". It is
 *      done here only so the payload this script hands over names each model
 *      once, which is what makes `enqueuedModelIds` a model count rather than a
 *      row count — ⚠️ PER BATCH, and only per batch. The run's total sums these
 *      per-batch lists without deduplicating across them, so the CROSS-batch
 *      double count INVERTS the collapse rates stated just above: it is
 *      near-certain on the default sweep, where a model's versions are not
 *      adjacent in id space and so land in different batches that each announce
 *      the model, and rarest under `--top`, where usage correlating within a
 *      model CAN put several of its versions in one batch, which this function
 *      then collapses. ⚠️ That clustering is statistical, not guaranteed:
 *      `topUsageVersionIds` orders by `generationCount` desc then
 *      `modelVersionId` asc, and nothing in it groups by model. So the escape
 *      is not a narrow boundary straddle — two versions of one model whose
 *      usage ranks differ by more than a batch width land in different batches
 *      and are each announced. That is why the summary reports `announcements
 *      issued` rather than a model count; see the `done:` line in `main`.
 *
 * Driven by `labels` — the rows that were actually written — not by the fetched
 * page, so a version whose answers failed to map does not get its model
 * re-indexed on the strength of a row that does not exist.
 */
export function labeledModelIds(
  versions: LabelableVersion[],
  labels: ResourceInsightLabel[]
): number[] {
  const modelIdByVersionId = new Map(versions.map((version) => [version.id, version.modelId]));
  const modelIds = new Set<number>();
  for (const label of labels) {
    const modelId = modelIdByVersionId.get(label.modelVersionId);
    // A label whose version is not in the page it came from cannot happen today;
    // skipping rather than defaulting keeps it from becoming an enqueue of
    // `undefined` if it ever does.
    if (modelId !== undefined) modelIds.add(modelId);
  }
  return [...modelIds];
}

/**
 * ONE read-back of the models update queue, to turn "the enqueue call returned"
 * into evidence about whether the ids are actually queued.
 *
 * Why this exists at all. `scripts/oneoffs/backfill-reaction-metric-exclusions.ts`
 * carries a MEASURED note saying `queueUpdate` fails open in a standalone script
 * — "332 ids queued, 0 of them in the queue", 2026-08-31 — and tells you not to
 * use it from a script. This pass does use it, for two reasons: the mechanism
 * that note blames (sysRedis never connecting) is not obviously present any
 * more, since the client calls `connect()` eagerly at module load and it is that
 * live socket which now stops this process exiting; and the parking lot that
 * recovers a dropped enqueue landed the same day the note was measured. Both of
 * those are arguments, not measurements, and an argument is not good enough for
 * the one call the whole change consists of. So the run measures it.
 *
 * `readOnly` is load-bearing: it does NOT append a new bucket or retire the
 * current ones, so this cannot consume work the 15-minute sync is about to pick
 * up. Same call the admin reindex endpoint uses for the same purpose.
 *
 * ONE-DIRECTIONAL, and the caller must report it that way — but the positive
 * direction is CORROBORATION, NOT PROOF, and the message must not claim more.
 * The `models_v9:Update` queue is shared with many other `queueUpdate` call
 * sites across the codebase — deliberately no count: it carries none of the
 * argument, and any count is corpus-dependent and not reproducible (it moves
 * with `src` vs `src`+`scripts`, with or without `__tests__`, and a grep counts
 * a string literal as a hit — see the
 * `invalidation('modelsSearchIndex.queueUpdate', …)` label sitting on the line
 * above its own call in `src/server/services/model.service.ts`), so do not
 * re-add a figure. An entry survives until the next
 * non-`readOnly` checkout (≤15 min), so presence is consistent with this run
 * having queued the ids and also with anything else having queued them. The
 * shape that makes that
 * concrete: one model in the first batch, every enqueue failing open into the
 * Postgres parking lot, and that model edited independently four minutes
 * earlier — `found === modelIds.length` and the run reports a healthy signal
 * while nothing it announced propagated. The check is still worth having: it is
 * the only observation of the fail-open case at all, and at realistic batch
 * widths an unrelated edit for EVERY id is unlikely. Absent ⇒ inconclusive: the
 * sync may have checked the queue out between the enqueue and this read. A read
 * that itself fails open returns an empty set, which is the same inconclusive
 * answer rather than a false negative dressed up as a finding.
 */
export async function verifyFirstEnqueue(modelIds: number[]): Promise<string> {
  if (modelIds.length === 0) return 'queue-verify: nothing enqueued yet';
  try {
    const queue = await SearchIndexUpdate.getQueue(
      MODELS_SEARCH_INDEX,
      SearchIndexUpdateQueueAction.Update,
      true
    );
    // A Set, not `Array.includes` per id: this queue reaches hundreds of
    // thousands of ids on a large fan-out, and the endpoint that does the same
    // read-back records that scanning it per id is enough to wedge a handler.
    const queued = new Set(queue.content);
    const found = modelIds.filter((id) => queued.has(id)).length;
    if (found === modelIds.length) {
      return `queue-verify: all ${found} model id(s) from the first batch are in the ${MODELS_SEARCH_INDEX} update queue (depth ${queue.content.length}) — consistent with announcements landing (the queue is shared, so presence is corroboration, not proof)`;
    }
    // 🔴 THREE causes, not two. The third is the one that blames the wrong
    // half: a degraded READ also lands here with nothing actually dropped —
    // `checkoutQueue` returns empty content when the bucket-list read fails
    // open and silently skips any bucket whose `sMembers` fails open, both
    // without throwing. So this line must not assert that the enqueue is at
    // fault; it lists the possibilities and names the signal that separates
    // them.
    return `queue-verify: INCONCLUSIVE — ${found}/${modelIds.length} model id(s) from the first batch found in the ${MODELS_SEARCH_INDEX} update queue (depth ${queue.content.length}). Any of three things: the 15-minute sync consumed them, the enqueue failed open and parked ids in Postgres, or this read itself failed open and under-reports a queue that is fine. Check the sysredis-fail-open signal to tell them apart before trusting this run's "queued" totals`;
  } catch (error) {
    return `queue-verify: could not read the queue back (${
      error instanceof Error ? error.message : error
    }) — this run's "queued" totals are unverified`;
  }
}

async function labelBatch(
  versions: LabelableVersion[],
  dryRun: boolean
): Promise<LabelBatchResult> {
  const { questions, state } = buildLabelQuestions(versions);
  const response = await askJev(
    { state, questions },
    // Ten resources x four questions in one request: allow ~3x the single-judgment budget.
    { timeoutMs: Math.max(JEV_TIMEOUT_MS * 3, 6000) }
  );
  const result: LabelBatchResult = {
    ...parseLabelAnswers(versions, response.answers),
    ...(response.usage.costUsd !== undefined ? { costUsd: response.usage.costUsd } : {}),
    enqueuedModelIds: [],
  };
  if (!dryRun && result.labels.length > 0) {
    try {
      await limitConcurrency(
        result.labels.map(
          (label) => () =>
            dbWrite.resourceInsight.upsert({
              where: { modelVersionId: label.modelVersionId },
              create: label,
              update: { ...label, stale: false },
            })
        ),
        LABEL_BATCH_SIZE
      );
    } catch (error) {
      // 🔴 THE PARTIAL-WRITE CASE, which is the mirror of the enqueue failure
      // below and is otherwise SILENT. `limitConcurrency` rejects on the first
      // task error, and there is no transaction, so rows are COMMITTED while
      // this batch is reported as failed. The throw reaches `main`'s per-batch
      // `catch`, which counts the whole batch failed and moves the cursor — and
      // a resumed run skips the committed rows as already-current
      // (`partitionNeedingLabel`), so their announcement is never attempted by
      // anything, ever.
      //
      // ⚠️ The committed set is WIDER than "the ones that had already finished",
      // and the precise shape matters because it is why the log is a superset
      // rather than an exact list. The reason is the GEOMETRY of this call site,
      // not `limitConcurrency`'s drain behaviour: `limit` here is
      // LABEL_BATCH_SIZE (10) and a batch carries AT MOST 10 labels, so the
      // initial `for (let i = 0; i < limit; i++) run()` loop in
      // src/server/utils/concurrency-helpers.ts launches EVERY upsert before any
      // of them can reject. Each one already in flight can therefore commit
      // AFTER this warning is printed and after `labelBatch` has returned, and
      // they also race the explicit exit in `runAsScript`, which makes the
      // committed set nondeterministic. Logging every label in the batch is the
      // only description guaranteed to cover it.
      //
      // ⚠️ What is NOT the reason, because an earlier draft of this comment said
      // it was: the `finally`'s re-`run()`. With the pool already exhausted it
      // finds no task and starts nothing. That path WOULD become load-bearing if
      // the limit and the batch size ever diverge — a batch wider than `limit`
      // leaves queued tasks for the `finally` to pull — so the conclusion above
      // (log every label; the set is a superset) survives either way, but do not
      // re-derive it from a mechanism that cannot fire at these two numbers.
      console.warn(
        `[label-resource-insights] upsert batch FAILED after a partial write; some rows may be committed WITHOUT an index announcement. Candidate model ids to re-queue by hand: ${labeledModelIds(
          versions,
          result.labels
        ).join(',')}`
      );
      throw error;
    }
    // 🔴 WRITING THE ROW IS NOT ENOUGH — ANNOUNCE IT.
    //
    // A model enters the incremental models-index sync on exactly three
    // conditions, spread over two files: `Model.createdAt >= lastUpdatedAt` and
    // `Model.updatedAt >= lastUpdatedAt` in `prepareModelsBatches`
    // (src/server/search-index/models.search-index.ts), and the index's own
    // update queue, which that function never touches — it is read by `update()`
    // in src/server/search-index/base.search-index.ts and unioned with
    // `updateIds`. A `ResourceInsight` upsert satisfies none of them: it touches
    // neither `Model` column. So without this call a labeled model is only
    // picked up by the manual full re-projection, which can go a very long time
    // between runs, and every insight attribute served from the index would be
    // a snapshot frozen at the last reset, decaying from the moment it finished.
    //
    // ⚠️ AFTER the upserts, and deliberately NOT part of them. There is no
    // transaction here to join: the upserts are independent statements run
    // through `limitConcurrency`, so there is no atomic unit an enqueue could be
    // made to share. Ordering it after the writes is what makes the queue entry
    // mean "a row exists to index"; enqueuing first would queue models whose
    // upserts then failed, and the index would rebuild them off the old row.
    //
    // ⚠️ ONE CALL PER BATCH, not per row — `queueUpdate` already takes a list,
    // and a batch is ~10 versions mapping to as few as one model.
    const modelIds = labeledModelIds(versions, result.labels);
    if (modelIds.length > 0) {
      try {
        await modelsSearchIndex.queueUpdate(
          modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
        );
        result.enqueuedModelIds = modelIds;
      } catch (error) {
        // 🔴 SWALLOWED ON PURPOSE. Throwing here would reach `main`'s per-batch
        // `catch`, which counts every version in the batch as FAILED — but the
        // rows are already committed and the vendor has already been paid for
        // this request, so that report is wrong twice over, and a resumed run
        // would re-spend on versions it had in fact labeled. An un-enqueued
        // model is stale in the index; a double-charged batch is money.
        //
        // ⚠️ NO KNOWN PATH REACHES THIS BLOCK, and it is worth saying so rather
        // than letting the next reader believe a redis fault shows up here.
        // `addToQueue` wraps every op in a deadline-raced fail-open, parks
        // dropped ids in Postgres for `search-index-queue-drain`, and
        // `persistDroppedEnqueue` catches even its own failure — so a degraded
        // queue returns `false`, which the wrappers discard, and resolves
        // normally. `queue-verify` below, not this block, is what observes that
        // case. This is kept as defence-in-depth because the property it
        // protects is money (never re-charge a committed batch) and the cost is
        // a few lines, NOT because it is live.
        console.warn(
          `[label-resource-insights] search-index enqueue FAILED for model ids ${modelIds.join(
            ','
          )} — rows are written; re-queue these models by hand:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }
  return result;
}

/**
 * `--top N` selection: the N highest-usage versions, materialised ONCE.
 *
 * 🔴 DO NOT PAGINATE OVER THE ORDERED METRIC, however natural keyset feels
 * here. `generationCount` is mutable and moves while a run is in flight, so a
 * keyset or OFFSET walk over `ORDER BY generationCount` is a walk over an
 * ordering that changes underneath it: rows cross page boundaries in both
 * directions and the run silently skips some and labels others twice. The ids
 * are therefore fetched in one ordered query and the run walks that fixed
 * array, which also makes resume an index into a stable list rather than a
 * cursor into a moving ordering.
 *
 * Usage is `generationCount` — how often a resource is actually used in a
 * generation. Deliberately not `downloadCount` (acquisition, not use) and not
 * `thumbsUpCount` (approval, not use). `ModelVersionMetric` is 1:1 with
 * `ModelVersion` (`@@id(modelVersionId)`, and it carries NO `timeframe`
 * column, unlike the User/Post/Collection/Tag metric tables), so there is one
 * row per version and no cross-timeframe double counting to guard against.
 *
 * The tiebreak is not decoration: `generationCount DESC` alone is not a total
 * order, so without it the slice at a given N is not reproducible run to run
 * and no validation conclusion drawn from it would be either.
 *
 * Selecting FROM the metric table means a version with no metric row at all is
 * not a candidate. That is correct at any N whose floor is above zero — such a
 * version has no recorded generations — and it is the reason this reads the
 * metric rather than left-joining it.
 */
export async function topUsageVersionIds(n: number): Promise<number[]> {
  const rows = await dbRead.modelVersionMetric.findMany({
    where: { modelVersion: LABELABLE_VERSION_FILTER },
    orderBy: [{ generationCount: 'desc' }, { modelVersionId: 'asc' }],
    take: n,
    select: { modelVersionId: true },
  });
  return rows.map((row) => row.modelVersionId);
}

/** Fetch one chunk of the materialised id list, re-applying the shared predicate. */
async function fetchVersionsByIds(ids: number[]): Promise<LabelableVersion[]> {
  const versions: LabelableVersion[] = await dbRead.modelVersion.findMany({
    where: { id: { in: ids }, ...LABELABLE_VERSION_FILTER },
    select: LABELABLE_VERSION_SELECT,
  });
  // Restore the ranked order: `findMany` does not promise the order of an `in`.
  const byId = new Map(versions.map((version) => [version.id, version]));
  return ids.map((id) => byId.get(id)).filter((v): v is LabelableVersion => v !== undefined);
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      // Re-label rows that are already current under the live spec (e.g. to
      // refresh confidence under an improved model pin). Default is to skip them.
      force: { type: 'boolean', default: false },
      // Opt-in, OFF by default: label only the N highest-usage versions instead
      // of sweeping the whole corpus by id. Bounds vendor spend for a validation
      // phase. Omitting it leaves the full keyset sweep exactly as it was.
      top: { type: 'string' },
    },
    strict: true,
  });
  const dryRun = !values.execute;
  const limit = values.limit ? Number.parseInt(values.limit, 10) : Infinity;
  let cursor = values.cursor ? Number.parseInt(values.cursor, 10) : 0;

  // Guarded because this flag is new. A bad value here would otherwise take the
  // `0 labeled` silent-success path that `--limit`/`--cursor` still have, and
  // adding a second instance of a defect this branch has already documented is
  // not something a new flag should do.
  let topIds: number[] | null = null;
  if (values.top !== undefined) {
    const n = Number.parseInt(values.top, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--top expects a positive integer, received "${values.top}"`);
    }
    topIds = await topUsageVersionIds(n);
    console.log(
      `[label-resource-insights] --top ${n}: materialised ${topIds.length} ids by generationCount`
    );
  }
  // In --top mode `--cursor` is an INDEX into the materialised list, not a
  // version id, because the list — not the id ordering — is what resume walks.
  let index = topIds ? cursor : 0;
  // Renders `cursor=<id>` in the default path — byte-identical to what this
  // script has always printed — and `index=<n>` under --top, where a version id
  // is not a resume token and printing one as if it were would mislead.
  const progress = () => (topIds ? `index=${index}` : `cursor=${cursor}`);

  let labeled = 0;
  let failed = 0;
  let skippedTotal = 0;
  // ANNOUNCEMENTS ISSUED to the search-index update queue — not confirmed
  // landed, and NOT a distinct-model count. 🔴 Two separate reasons not to read
  // it as either. (a) `addToQueue` fails open and the wrappers discard its
  // boolean, so this number is identical on a healthy run and on one whose
  // every enqueue was parked in Postgres; `queueVerified` below is the
  // measurement, this is the volume. (b) It SUMS the per-batch lists, each of
  // which is deduplicated only within its own batch, so a model announced by
  // two batches is counted twice — NEAR-CERTAIN on the default sweep, which
  // walks version ids in order, so a model's versions are not adjacent and land
  // in different batches that each announce it; expect this to track the
  // labeled-VERSION count there rather than the distinct-model count. `--top`
  // is where it is RAREST, because usage correlating within a model can put
  // several of its versions in one batch where `labeledModelIds` collapses
  // them — statistically, not by construction: nothing in the `--top` ordering
  // groups by model, so versions whose usage ranks differ by more than a batch
  // width still land in different batches. See `labeledModelIds` for why the
  // two paths differ.
  // The consequence is a mis-sized load expectation, never wrong
  // indexing: the queue is a redis set, so the duplicate announcement is free.
  // The printed label says `announcements issued` for exactly this reason; do
  // not "fix" it back to a model count without deduplicating across batches.
  let indexQueued = 0;
  // One-shot, after the first batch that actually enqueues. See
  // `verifyFirstEnqueue` for why a read-back exists and why it is one-shot.
  let queueVerified = false;
  // Measured spend, accumulated from what the vendor reports per request.
  // `costUnreportedBatches` is tracked alongside rather than folded in as zero,
  // so the printed total can say how much of the run it actually covers — an
  // unqualified total that hid unreported batches would read as complete, and
  // understating spend is the direction that matters for a number whose job is
  // to bound a budget.
  let spentUsd = 0;
  let costedBatches = 0;
  let costUnreportedBatches = 0;
  const spend = () =>
    `spent=$${spentUsd.toFixed(6)} over ${costedBatches} batch(es)` +
    (costUnreportedBatches > 0 ? `, ${costUnreportedBatches} unreported` : '');
  let lastId = cursor;

  while (labeled + failed < limit) {
    const take = Math.min(LABEL_BATCH_SIZE, limit - labeled - failed);
    let versions: LabelableVersion[];
    if (topIds) {
      const chunk = topIds.slice(index, index + take);
      if (chunk.length === 0) break;
      index += chunk.length;
      versions = await fetchVersionsByIds(chunk);
    } else {
      versions = await dbRead.modelVersion.findMany({
        where: { id: { gt: cursor }, ...LABELABLE_VERSION_FILTER },
        orderBy: { id: 'asc' },
        take,
        select: LABELABLE_VERSION_SELECT,
      });
    }
    if (versions.length === 0) {
      // Default path: an empty page means the corpus is exhausted, so stop. In
      // --top mode the terminator is the exhausted id list, checked above; an
      // empty fetch here only means every id in THIS chunk stopped being
      // labelable since the list was materialised, so advance rather than
      // mistake one dead chunk for the end of the run.
      if (topIds) continue;
      break;
    }

    let batchVersions = versions;
    if (!values.force) {
      const existing = await dbRead.resourceInsight.findMany({
        where: { modelVersionId: { in: versions.map((version) => version.id) } },
        select: { modelVersionId: true, specHash: true, stale: true },
      });
      const { toLabel, skipped } = partitionNeedingLabel(versions, existing, LABEL_SPEC_HASH);
      batchVersions = toLabel;
      if (skipped > 0) {
        cursor = versions[versions.length - 1].id;
        lastId = cursor;
        skippedTotal += skipped;
        console.log(
          `[label-resource-insights] ${
            dryRun ? 'DRY RUN ' : ''
          }skipped ${skipped} current rows, ${progress()}`
        );
        continue;
      }
    }
    if (batchVersions.length === 0) {
      cursor = versions[versions.length - 1].id;
      lastId = cursor;
      continue;
    }

    let batch: LabelBatchResult;
    try {
      batch = await labelBatch(batchVersions, dryRun);
    } catch (error) {
      // A whole-batch transport failure skips the batch — nothing was judged,
      // so there is nothing to isolate per resource. The cursor moves past it;
      // the skipped ids are recoverable by re-running with an earlier cursor.
      console.warn(
        `[label-resource-insights] batch failed after id ${cursor}:`,
        error instanceof Error ? error.message : error
      );
      cursor = versions[versions.length - 1].id;
      lastId = cursor;
      failed += versions.length;
      continue;
    }

    labeled += batch.labels.length;
    failed += batch.failedVersionIds.length;
    indexQueued += batch.enqueuedModelIds.length;
    // The first batch that announced anything is the one worth measuring: if
    // the enqueue is failing open it is failing open for every batch, so one
    // read-back answers the question for the whole run.
    if (!queueVerified && batch.enqueuedModelIds.length > 0) {
      queueVerified = true;
      console.log(`[label-resource-insights] ${await verifyFirstEnqueue(batch.enqueuedModelIds)}`);
    }
    if (batch.costUsd === undefined) {
      costUnreportedBatches += 1;
    } else {
      spentUsd += batch.costUsd;
      costedBatches += 1;
    }
    cursor = versions[versions.length - 1].id;
    lastId = cursor;
    console.log(
      `[label-resource-insights] ${dryRun ? 'DRY RUN ' : ''}labeled ${
        batch.labels.length
      }, failed ${batch.failedVersionIds.length}, queued ${
        batch.enqueuedModelIds.length
      }, ${progress()}, ${spend()}`
    );
  }

  console.log(
    `[label-resource-insights] done: ${labeled} labeled, ${failed} failed, ${skippedTotal} skipped-current, ${indexQueued} reindex announcements issued, ${spend()}, ${
      topIds ? `index=${index}` : `lastId=${lastId}`
    }, labelSpec=${LABEL_SPEC_HASH.slice(0, 12)}` + (dryRun ? ' (dry run — nothing written)' : '')
  );
}

/**
 * The entry-point wrapper: run `main()`, FLUSH, then exit explicitly.
 *
 * 🔴 BOTH HALVES ARE LOAD-BEARING AND THEY ARE IN TENSION, which is the only
 * reason this is a function rather than two lines in the tail guard.
 *
 *   EXIT, because the process can no longer end on its own. Announcing to the
 *   search index pulls in the redis clients, which connect at module load and
 *   arm a ping interval, so the event loop never drains and a finished run
 *   hangs after printing its summary. `scripts/seed-scanner-policies.ts` has
 *   the same problem and the same fix.
 *
 *   FLUSH FIRST, because `process.exit()` does NOT drain pending async writes,
 *   and stdout to a PIPE is async. Measured on node 24.19.0 with a 2001-line
 *   writer: exiting bare TRUNCATES INTERMITTENTLY over a pipe. ⚠️ No single
 *   figure is quoted AS THE RATE — two independent replications of that setup
 *   disagreed (one lost the final line in every piped run it tried; the other
 *   saw loss in 1 of 3 piped to `cat` and 2 of 10 piped to `wc -l`), so the
 *   honest claim is that it is NONDETERMINISTIC, and an earlier draft of this
 *   comment asserting "3 of 3" was overstating a figure that does not
 *   replicate. 🔴 Both figures stay: their DISAGREEMENT is the evidence of
 *   nondeterminism and the only real measurement in this arc, so do not
 *   "reconcile" this passage by deleting them. Both
 *   replications agree on the DIRECTION: bare exit truncates, drain-then-exit
 *   delivered every line in every run, as did the no-exit control. Intermittence
 *   is precisely why the drain is unconditional — there is no individual run you
 *   can look at and conclude you did not need it. Redirecting to a FILE is
 *   unaffected, which is exactly what makes this easy to miss.
 *
 * Why that matters more here than it looks: the LAST line is the one carrying
 * `lastId=` / `index=` — the resume token — and this script spends vendor money
 * per batch. An operator who pipes the run (`| tee`, a cron harness, a log
 * shipper) and loses that line resumes from a stale cursor and RE-PAYS for
 * versions already labeled. The hang this exit fixes is an annoyance; a lost
 * cursor is a bill.
 *
 * `exit` is injected so the behaviour is testable: `main` is exported and five
 * test files call it directly, so a real `process.exit` anywhere reachable from
 * them would kill the vitest worker. The tail guard runs only when this file is
 * the entry point, which is never true under the runner.
 *
 * 🔴 BOTH DEFAULTS ARE THE PRODUCTION BINDING, AND THE ONLY CALL SITE PASSES
 * NEITHER — so a test that injects both exercises the seam and NOT what ships.
 * Measured: replacing `= drainStdio` with `= async () => {}` and `= process.exit`
 * with `= () => {}` each left all 21 tests of
 * scripts/__tests__/label-resource-insights-index-enqueue.test.ts green, and the
 * first of those two mutants silently restores the truncated-resume-token defect
 * this wrapper exists to fix. The defaults are therefore pinned by their own
 * tests (`runAsScript(exit)` with the real `drainStdio`; `runAsScript(undefined,
 * flush)` against a spied `process.exit`). The THIRD test imports `drainStdio`
 * from ./lib/run-as-script and watches it WAIT on the write callbacks;
 * `drainStdio`'s own docstring there is the single explanation. Do not collapse
 * the signature or "simplify" the defaults away.
 */
export async function runAsScript(
  exit: (code: number) => void = process.exit,
  // Injected together with `exit` so a test can assert the ORDER — a drain that
  // runs after the exit would be inert, and nothing else could see that.
  flush: () => Promise<void> = drainStdio
): Promise<void> {
  // The drain-then-exit rule itself lives in ./lib/run-as-script (shared with the M3
  // gold-set runner); `drainStdio` moved there with it.
  await runScriptAndExit(main, exit, flush);
}

if (process.argv[1]?.endsWith('label-resource-insights.ts')) {
  void runAsScript();
}
