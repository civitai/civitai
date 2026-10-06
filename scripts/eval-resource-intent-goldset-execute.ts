import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbRead } from '~/server/db/client';
import { askJev, JEV_TIMEOUT_MS } from '~/server/services/ai/jev';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import {
  buildResourceIntentStage1Request,
  compileCriteria,
  parseResourceIntentStage1Answers,
} from '~/server/services/resource-intent-stage1';
import type { ResourceIntentAnswer } from '~/server/schema/resource-intent.schema';
import {
  evaluateGoldset,
  renderGoldsetReport,
  type GoldsetJudgment,
  type GoldsetRow,
} from './eval-resource-intent-goldset';
import {
  GOLDSET_MATCHED_SQL,
  GOLDSET_UNMATCHED_SQL,
  M3_RETRIEVAL_PREREGISTRATION,
  type RetrievalRunParams,
} from './eval-resource-intent-registration';
import {
  countLabeledIndexDocuments,
  evaluateRetrieval,
  loadLabeledModelIds,
  renderRetrievalReport,
  runRetrievalArms,
  type RetrievalGoldRow,
} from './eval-resource-intent-retrieval';

/**
 * The `--execute` half of `./eval-resource-intent-goldset.ts`: everything that reads the
 * replica, the models index or the vendor. Loaded by a dynamic import only under
 * `--execute`, so the dry run never constructs a database or search client.
 */

type MatchedSqlRow = GoldsetRow & {
  attachedModels: { modelId: number; modelType: string }[];
  checkpointBaseModels: string[];
};

export async function executeGoldsetStudy({
  days,
  matchedLimit,
  unmatchedLimit,
  matchedDraw,
  retrievalParams,
  out,
}: {
  days: number;
  matchedLimit: number;
  unmatchedLimit: number;
  matchedDraw: number;
  retrievalParams: RetrievalRunParams;
  out: string | undefined;
}): Promise<void> {
  // The retrieval study's positive control runs FIRST, before any vendor spend, and so
  // also gates part one: a models index with no projected `insight.role` would turn
  // the purpose arm into the popularity arm and the study into a silent null result.
  const labeledIndexDocuments = await countLabeledIndexDocuments();
  if (labeledIndexDocuments < M3_RETRIEVAL_PREREGISTRATION.labeledIndexFloor) {
    throw new Error(
      `[goldset] positive control FAILED: ${labeledIndexDocuments} models-index documents carry a non-none insight.role (floor ${M3_RETRIEVAL_PREREGISTRATION.labeledIndexFloor}). The purpose arm cannot differ from the popularity arm on this index; aborting before any vendor call.`
    );
  }

  const matched = await dbRead.$queryRaw<MatchedSqlRow[]>(GOLDSET_MATCHED_SQL(days, matchedDraw));
  const unmatched = await dbRead.$queryRaw<GoldsetRow[]>(
    GOLDSET_UNMATCHED_SQL(days, unmatchedLimit)
  );

  const partOneRows: GoldsetRow[] = [...matched.slice(0, matchedLimit), ...unmatched];
  const pairs: { row: GoldsetRow; judgment: GoldsetJudgment }[] = [];
  for (const row of partOneRows) {
    const stage1 = await runStage1(row.prompt, null);
    if (!stage1) {
      console.warn(`[goldset] stage-1 failed for image ${row.imageId}; row skipped`);
      continue;
    }
    pairs.push({ row, judgment: stage1.intent });
  }

  // Part two: the pre-registered retrieval comparison.
  const retrievalRows: RetrievalGoldRow[] = matched
    .slice(0, retrievalParams.sampleSize)
    .map((row) => ({
      imageId: row.imageId,
      prompt: row.prompt,
      attachedModels: row.attachedModels,
      checkpointBaseModels: row.checkpointBaseModels,
    }));
  const labeledModelIds = await loadLabeledModelIds([
    ...new Set(retrievalRows.flatMap((row) => row.attachedModels.map((m) => m.modelId))),
  ]);
  const outcomes = await runRetrievalArms(retrievalRows, {
    stage1: runStage1,
    armOpts: {
      browsingLevel: allBrowsingLevelsFlag,
      // The anonymous audience, resolved exactly as the endpoint does on a cache miss.
      coverage: await coverageAudience(undefined),
      cap: M3_RETRIEVAL_PREREGISTRATION.cap,
    },
    labeledModelIds,
  });
  const retrieval = evaluateRetrieval(outcomes, retrievalParams);

  const report = [
    renderGoldsetReport(evaluateGoldset(pairs), { drawn: partOneRows.length }),
    renderRetrievalReport(retrieval, { labeledIndexDocuments }),
  ].join('\n');
  if (out) {
    const { writeFile } = await import('fs/promises');
    await writeFile(out, report);
    console.log(
      `[goldset] report written to ${out} (${pairs.length} of ${partOneRows.length} stage-1 rows judged, ${retrieval.primary.n} retrieval prompts scored)`
    );
  } else {
    console.log(report);
  }
}

/**
 * Stage 1 for one prompt, through the endpoint's own request builder, answer parser
 * and criteria compiler. `null` on any failure (vendor error, wrong shape, spec
 * desync) — the caller counts it, the endpoint would have degraded.
 */
async function runStage1(
  prompt: string,
  baseModel: string | null
): Promise<{ intent: ResourceIntentAnswer; criteria: ReturnType<typeof compileCriteria> } | null> {
  try {
    const response = await askJev(buildResourceIntentStage1Request(prompt, baseModel), {
      timeoutMs: JEV_TIMEOUT_MS,
    });
    const intent = parseResourceIntentStage1Answers(response.answers);
    if (!intent) return null;
    return { intent, criteria: compileCriteria(intent, baseModel) };
  } catch (error) {
    console.warn(`[goldset] stage-1 error: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
