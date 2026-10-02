import { createHash } from 'crypto';
import { parseArgs } from 'util';

import { dbRead, dbWrite } from '~/server/db/client';
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

/** The columns a label judgment is derived from. Shared by both selection paths. */
export const LABELABLE_VERSION_SELECT = {
  id: true,
  name: true,
  baseModel: true,
  trainedWords: true,
  description: true,
  model: { select: { type: true, nsfw: true } },
} as const;

export type LabelableVersion = {
  id: number;
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

export type LabelBatchResult = {
  labels: ResourceInsightLabel[];
  failedVersionIds: number[];
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
): LabelBatchResult {
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
  };
  if (!dryRun && result.labels.length > 0) {
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
      }, failed ${batch.failedVersionIds.length}, ${progress()}, ${spend()}`
    );
  }

  console.log(
    `[label-resource-insights] done: ${labeled} labeled, ${failed} failed, ${skippedTotal} skipped-current, ${spend()}, ${
      topIds ? `index=${index}` : `lastId=${lastId}`
    }, labelSpec=${LABEL_SPEC_HASH.slice(0, 12)}` + (dryRun ? ' (dry run — nothing written)' : '')
  );
}

if (process.argv[1]?.endsWith('label-resource-insights.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
