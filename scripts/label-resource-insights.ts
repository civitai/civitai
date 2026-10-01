import { createHash } from 'crypto';
import { parseArgs } from 'util';

import { dbRead, dbWrite } from '~/server/db/client';
import { askJev, JEV_TIMEOUT_MS, type JevQuestionSpec } from '~/server/services/ai/jev';
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
 * The corpus is ~975k published versions; the binding constraint is the vendor
 * throughput cap, so resources are labeled in SHARED REQUESTS of
 * LABEL_BATCH_SIZE versions each (one round trip, per-resource questions with
 * stable `r<idx>.<question>` ids). The fleet run is a gated follow-up — apply
 * the migration to the target environment first (nothing auto-applies it).
 *
 * Cursoring is keyset (`id > cursor ORDER BY id`): a version created mid-run
 * cannot shift a page out from under the scan. Resume by re-running with the
 * last `cursor=N` value this script prints.
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
    prompt:
      'Judging only from this metadata, how well does this resource serve that role? 1 = poor fit, 10 = exemplary.',
    min: 1,
    max: 10,
  },
] as const satisfies readonly JevQuestionSpec[];

export const LABEL_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(LABEL_QUESTION_SPEC))
  .digest('hex');

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
      confidence: role.confidence ?? 0,
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
  const result = parseLabelAnswers(versions, response.answers);
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

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      // Re-label rows that are already current under the live spec (e.g. to
      // refresh confidence under an improved model pin). Default is to skip them.
      force: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const dryRun = !values.execute;
  const limit = values.limit ? Number.parseInt(values.limit, 10) : Infinity;
  let cursor = values.cursor ? Number.parseInt(values.cursor, 10) : 0;

  let labeled = 0;
  let failed = 0;
  let skippedTotal = 0;
  let lastId = cursor;

  while (labeled + failed < limit) {
    const take = Math.min(LABEL_BATCH_SIZE, limit - labeled - failed);
    const versions: LabelableVersion[] = await dbRead.modelVersion.findMany({
      where: {
        id: { gt: cursor },
        status: 'Published',
        // Exclude Private, NOT Unsearchable. `Unsearchable` is "public but kept
        // out of search results" (see the enum's own comment in
        // packages/civitai-db-schema/prisma/schema.full.prisma), so excluding it
        // drops public resources while still admitting private ones. The
        // serving-side matcher gates on the same member — see
        // src/server/services/resource-intent-matcher.service.ts, which filters
        // `ne('availability', Availability.Private)`. Both the version's own
        // availability and its model's are checked: either one being Private
        // must keep the row out, and the two are independent.
        availability: { not: Availability.Private },
        model: { status: 'Published', availability: { not: Availability.Private } },
      },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        name: true,
        baseModel: true,
        trainedWords: true,
        description: true,
        model: { select: { type: true, nsfw: true } },
      },
    });
    if (versions.length === 0) break;

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
          }skipped ${skipped} current rows, cursor=${cursor}`
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
    cursor = versions[versions.length - 1].id;
    lastId = cursor;
    console.log(
      `[label-resource-insights] ${dryRun ? 'DRY RUN ' : ''}labeled ${
        batch.labels.length
      }, failed ${batch.failedVersionIds.length}, cursor=${cursor}`
    );
  }

  console.log(
    `[label-resource-insights] done: ${labeled} labeled, ${failed} failed, ${skippedTotal} skipped-current, lastId=${lastId}, labelSpec=${LABEL_SPEC_HASH.slice(
      0,
      12
    )}` + (dryRun ? ' (dry run — nothing written)' : '')
  );
}

if (process.argv[1]?.endsWith('label-resource-insights.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
