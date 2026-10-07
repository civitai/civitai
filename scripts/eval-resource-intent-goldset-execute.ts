import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbRead } from '~/server/db/client';
import { askJev, JEV_TIMEOUT_MS } from '~/server/services/ai/jev';
import { parseLocalOverrides } from '@civitai/flipt';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import type { ResourceIntentCoverage } from '~/server/services/resource-intent-matcher.service';
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
  // Coverage first: if the flags behind it cannot be evaluated, the run would grade a filter
  // the endpoint does not use. Fails closed, before any index read or vendor call.
  const coverage = await resolveEndpointCoverage();

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
      coverage,
      cap: M3_RETRIEVAL_PREREGISTRATION.cap,
    },
    labeledModelIds,
  });
  const retrieval = evaluateRetrieval(outcomes, retrievalParams);

  const report = [
    renderGoldsetReport(evaluateGoldset(pairs), { drawn: partOneRows.length }),
    renderRetrievalReport(retrieval, { coverage }),
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
  await closeStudyHandles();
}

/**
 * Close what the study opened, so a finished `--execute` exits instead of hanging: the
 * replica's Prisma pool (an idle session otherwise sits until the server times it out)
 * and the Flipt SDK client (its config poller is a timer that keeps the process alive).
 * The entry point (`runAsScript` in ./eval-resource-intent-goldset.ts) also exits
 * explicitly once `main()` settles, because a handle opened deeper in the server graph
 * cannot be enumerated from here; this is the clean half, that is the guarantee.
 */
export async function closeStudyHandles(deps?: {
  disconnectDb: () => Promise<void>;
  closeFlipt: () => void;
}): Promise<void> {
  const { disconnectDb, closeFlipt } = deps ?? {
    disconnectDb: () => dbRead.$disconnect(),
    // The SDK's package-root types declare its BROWSER client, which has no `close()`;
    // under Node the NODE client is loaded, whose `close()` clears the config-refresh
    // `setInterval` that keeps the process alive. Hence the structural type, not the import.
    closeFlipt: () => (getFliptClientSync() as unknown as { close?: () => void } | null)?.close?.(),
  };
  try {
    closeFlipt();
  } finally {
    await disconnectDb();
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

/**
 * The flags `coverageAudience` reads for an anonymous caller, with the entity id it passes.
 * `GENERATION_LOADING_OPEN_TO_ALL` is read only when the first is on; both are checked here
 * regardless, so a half-reachable Flipt cannot slip through on one branch.
 */
const COVERAGE_FLAGS = [
  { flag: FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT, entityId: 'global' },
  { flag: FLIPT_FEATURE_FLAGS.GENERATION_LOADING_OPEN_TO_ALL, entityId: '0' },
] as const;

/**
 * The coverage the endpoint resolves for an anonymous caller — or an error, never a guess.
 *
 * 🔴 `coverageAudience` cannot be trusted on its own here. It reads flags through `isFlipt`,
 * which returns `false` both for a flag that is really off AND when the Flipt client never
 * initialised (unreachable, bad credentials) or the flag failed to evaluate. The two are
 * indistinguishable through `isFlipt`, so an unreachable Flipt silently yields the flag
 * defaults — which is how the first pilot (2026-10-06) graded `{next:false, member:true}`
 * while the endpoint resolves `{next:true, member:false}`.
 *
 * So, after initialising Flipt, this refuses three ways before letting the endpoint's own
 * `coverageAudience` resolve the value (one rule, not a copy):
 *   1. `FLIPT_LOCAL_OVERRIDES` names a coverage flag. A local override is answered BEFORE
 *      the client is consulted (by `isFlipt` and `isFliptSync` alike) whenever NODE_ENV is
 *      not production, and `pnpm run tsscript` runs development — so an override passes
 *      every check below with Flipt unreachable. Refused regardless of NODE_ENV.
 *   2. No initialised client (`getFliptClientSync()` is null): Flipt is unreachable.
 *   3. Any coverage flag whose evaluation is `null` through `isFliptSync` (missing flag or
 *      an evaluation error).
 */
export async function resolveEndpointCoverage(
  deps: Partial<{
    ensureInitialized: () => Promise<void>;
    overriddenFlags: () => string[];
    clientInitialised: () => boolean;
    evaluateSync: (flag: string, entityId: string) => boolean | null;
    audience: () => Promise<ResourceIntentCoverage>;
  }> = {}
): Promise<ResourceIntentCoverage> {
  const {
    ensureInitialized = ensureFliptInitialized,
    overriddenFlags = () => Object.keys(parseLocalOverrides(process.env.FLIPT_LOCAL_OVERRIDES)),
    clientInitialised = () => getFliptClientSync() !== null,
    evaluateSync = (flag: string, entityId: string) => isFliptSync(flag, entityId),
    audience = () => coverageAudience(undefined),
  } = deps;
  await ensureInitialized();
  const abort = (why: string) =>
    new Error(
      `[goldset] ${why} — coverage would not be what the endpoint resolves; aborting before any index read or vendor call.`
    );
  const overridden = COVERAGE_FLAGS.map(({ flag }) => flag).filter((flag) =>
    overriddenFlags().includes(flag)
  );
  if (overridden.length) {
    throw abort(`FLIPT_LOCAL_OVERRIDES sets ${overridden.join(', ')}`);
  }
  if (!clientInitialised()) {
    throw abort('the Flipt client did not initialise (Flipt unreachable)');
  }
  const unevaluated = COVERAGE_FLAGS.filter(
    ({ flag, entityId }) => evaluateSync(flag, entityId) === null
  ).map(({ flag }) => flag);
  if (unevaluated.length) {
    throw abort(`feature flags could not be evaluated (${unevaluated.join(', ')})`);
  }
  return audience();
}
