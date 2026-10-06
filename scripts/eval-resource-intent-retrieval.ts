import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { searchClient } from '~/server/meilisearch/client';
import { loadResourceInsights, modelInsightProjection } from '~/server/services/resource-insight';
import { inArray } from '~/shared/utils/meili-filter';
import {
  buildResourceIntentSeedQueries,
  expandShortlist,
  findResourceIntentCandidates,
  resolveResourceIntentSeedPlan,
  searchResourceIntentSeedPage,
  type ResourceIntentCoverage,
  type ResourceIntentShortlistEntry,
} from '~/server/services/resource-intent-matcher.service';
import {
  RESOURCE_INTENT_DEFAULT_LIMIT,
  RESOURCE_INTENT_ROLE_OPTIONS,
  RESOURCE_INTENT_SPEC_HASH,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentCriteria,
  type ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';

/**
 * M3, part two — the two-arm RETRIEVAL comparison, run from
 * `./eval-resource-intent-goldset.ts`.
 *
 * The question: on prompts people actually generated with, does the shipped
 * purpose-first matcher (PURPOSE arm) put a resource they really attached near the top
 * more often than the pre-insight popularity seed alone (POPULARITY arm)?
 *
 * Everything that decides the answer is fixed BEFORE any run, in
 * `M3_RETRIEVAL_PREREGISTRATION` below and the text `renderRetrievalPreregistration`
 * builds from it, which the dry run prints and every report opens with. The doc points
 * here rather than keeping a copy.
 *
 * Committed, NOT executed: a live run needs a prod replica read, the models index and
 * an OpenRouter key, and is meant to run only once the purpose-first seed is serving
 * from a `release` build.
 */

/**
 * 🔴 The pre-registered constants. Changing any of these after a run has been seen
 * turns the study into a fishing expedition. The CLI can override two of them (sample
 * size and sample window, for the pilot); an override prints a warning, stamps the report
 * as NOT the pre-registered run, and makes its verdict VOID.
 *
 * Why these values:
 *   - `primaryK` 10: the head of the shortlist, where the two arms are designed to
 *     differ — the purpose arm promotes labeled matches INTO the head; at K = cap the
 *     arms see more nearly the same set and the comparison dilutes toward zero.
 *   - `secondaryK` 50: the endpoint's default response width
 *     (`RESOURCE_INTENT_DEFAULT_LIMIT`), i.e. "anywhere in what stage 3 is shown".
 *   - `sampleSize` 1000 drawn images: given the discordant split, McNemar's power
 *     depends only on the DISCORDANT count. Exact two-sided α = 0.05 needs a 61/39 split
 *     at 100 discordant pairs and 83/57 at 140; power against a true 65/35 split is 0.83
 *     at 100 and 0.93 at 140. Reaching 100 discordant pairs needs the two
 *     `powerAssumption` rates below (667 scored × 15% ≈ 100). Both are ASSUMPTIONS: the
 *     pilot measures them, and the report prints both against these values. The cost is
 *     one stage-1 vendor call per drawn image plus two or three index pages when the arms
 *     run, on top of part one's own ~`--limit` stage-1 calls (about half of them
 *     re-judging prompts in this sample, with no baseModel).
 *   - `cap` 50 = `RESOURCE_INTENT_DEFAULT_LIMIT`, the width a caller gets by default.
 *   - `voidIf` — a run too degraded to judge the clause is VOID, not a binding NOT MET:
 *     - `minScored` 667: the scored n the power calculation above assumes (1000 drawn ×
 *       66.7%). Below it the registered power no longer holds, so a failure to reach
 *       significance is not a powered negative. A substantive shortfall (many `none` or
 *       no-in-role prompts) lands here too — which is what the pilot exists to catch
 *       before the registered run.
 *     - `maxInfraExclusionFraction` 0.10: stage-1 failures, arm errors and label-read
 *       fallbacks are infrastructure, not properties of the prompt. They are not random
 *       missingness — a quota or an outage takes out a contiguous slice of the run — so
 *       above 10% of drawn prompts the scored set is no longer the registered sample.
 *       10% leaves the rest of the 33.3% exclusion budget the power assumption allows to
 *       the substantive exclusions.
 *   - `labeledIndexFloor` 100: the positive control. The PURPOSE arm filters on
 *     `insight.role`; if no index document carries one, its purpose page is empty, it
 *     degenerates to the popularity arm, and the study reads "no difference" — a null
 *     result rather than an error. The floor is far below the real labeled count, so it
 *     only catches a TOTAL projection fault, by design.
 */
export const M3_RETRIEVAL_PREREGISTRATION = {
  version: 1,
  registeredOn: '2026-10-06',
  primaryK: 10,
  secondaryK: RESOURCE_INTENT_DEFAULT_LIMIT,
  alpha: 0.05,
  sampleSize: 1000,
  sampleDays: 30,
  cap: RESOURCE_INTENT_DEFAULT_LIMIT,
  labeledIndexFloor: 100,
  powerAssumption: { discordantRate: 0.15, scoredFraction: 0.667 },
  voidIf: { minScored: 667, maxInfraExclusionFraction: 0.1 },
  pilotSampleSize: 100,
} as const;

export type RetrievalRunParams = {
  sampleSize: number;
  sampleDays: number;
};

/** The CLI-overridable subset, at its pre-registered values. */
export const PREREGISTERED_RUN_PARAMS: RetrievalRunParams = {
  sampleSize: M3_RETRIEVAL_PREREGISTRATION.sampleSize,
  sampleDays: M3_RETRIEVAL_PREREGISTRATION.sampleDays,
};

/** Every overridden parameter, as `name: preregistered -> used`. Empty ⇒ the registered run. */
export function preregistrationOverrides(params: RetrievalRunParams): string[] {
  return (Object.keys(PREREGISTERED_RUN_PARAMS) as (keyof RetrievalRunParams)[])
    .filter((key) => params[key] !== PREREGISTERED_RUN_PARAMS[key])
    .map((key) => `${key}: ${PREREGISTERED_RUN_PARAMS[key]} -> ${params[key]}`);
}

/**
 * The pre-registration as text — printed by the dry run and at the top of every report.
 * Built from the constants so the text cannot state a value the code does not use.
 */
export function renderRetrievalPreregistration(): string {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const k = p.primaryK;
  return [
    `M3 RETRIEVAL PRE-REGISTRATION v${p.version} (registered ${p.registeredOn}, before any run)`,
    '',
    'Question: does the shipped purpose-first matcher (PURPOSE arm) retrieve a resource',
    'people actually attached more often than the popularity seed alone (POPULARITY arm)?',
    '',
    `Sample: ${p.sampleSize} images drawn at random from the last ${p.sampleDays} days with a`,
    'non-empty public prompt (hideMeta false) and >=1 attached resource, that are publicly',
    'searchable: scanned, not in a review queue, not ToS-violating, blocked, or flagged',
    'minor or POI, in a published (not scheduled) post that is neither Private nor',
    'Unsearchable, and with no attached model flagged POI or minor.',
    "Stage 1: run per prompt through the endpoint's own request builder and answer parser,",
    "with baseModel = the base model of the image's attached checkpoint when exactly one",
    'is attached, otherwise none. Stage 3 is not run by either arm.',
    'Gold: the attached models (ImageResourceNew -> ModelVersion -> Model) whose type is in',
    'ROLE_MODEL_TYPES[stage-1 role]. Attached models of other types are excluded from the',
    'gold; their share is reported, with checkpoints (which no role admits) also reported',
    'apart from it.',
    `Arms: identical criteria, browsingLevel (all levels), coverage (the anonymous audience,`,
    `resolved as the endpoint does) and cap (${p.cap}). PURPOSE = findResourceIntentCandidates`,
    '(purpose-first seed + label re-rank). POPULARITY = the same gate filter, sorted by',
    'metrics.thumbsUpCount:desc alone, expanded and capped the same way, no label ordering.',
    '',
    `Primary metric: hit@${k} = the fraction of scored prompts where at least one gold`,
    `model id is among the arm's first ${k} distinct shortlist model ids.`,
    `Discordant pairs at hit@${k}: b = PURPOSE hit and POPULARITY miss, c = the reverse.`,
    `Decision rule: PURPOSE beats POPULARITY iff b > c AND the exact two-sided McNemar p`,
    `on (b, c) is < ${p.alpha}.`,
    '',
    'Verdict on the closing clause — every run reports exactly one:',
    '  MET     — the decision rule holds.',
    '  NOT MET — it does not. The closing clause is judged not met and the question is',
    '            closed as not delivered. Any follow-up (better gold, new labels) is new',
    '            work under a new registration, not a re-run of this one.',
    `  VOID    — no verdict on the clause, if ANY of: a registered value was overridden`,
    `            (including the ${p.pilotSampleSize}-prompt pilot); fewer than ${p.voidIf.minScored} prompts scored (the n the`,
    `            power calculation assumes); infrastructure exclusions (stage-1 failure,`,
    `            arm error, label-read fallback) exceed ${(
      p.voidIf.maxInfraExclusionFraction * 100
    ).toFixed(0)}% of drawn prompts; or both`,
    `            arms returned the same first ${k} model ids on every scored prompt. (A failed`,
    '            positive control aborts before any run, so it produces no report at all.)',
    '',
    `Secondary (reported, never decisive): hit@${p.secondaryK} and MRR@${p.secondaryK}, and`,
    `hit@${k} stratified by whether any gold model carries a non-stale ResourceInsight`,
    'label at or above the promote-confidence floor the index projection applies.',
    '',
    'Excluded and counted, never scored: a stage-1 failure, role = none, no in-role',
    'attachment, either arm erroring, and a PURPOSE label read that fell back.',
    `Positive control: abort before any vendor call unless >= ${p.labeledIndexFloor} index`,
    'documents carry a non-none insight.role.',
    `Power assumption (measured by the pilot first): >= ${(
      p.powerAssumption.scoredFraction * 100
    ).toFixed(1)}% of drawn prompts score, and the`,
    `arms are discordant at hit@${k} on >= ${(p.powerAssumption.discordantRate * 100).toFixed(
      1
    )}% of scored prompts.`,
    '',
    'Known confound: people attach popular models, so attached-resource gold is biased',
    'TOWARD the POPULARITY arm. A MET verdict is therefore conservative. A NOT MET verdict',
    'stands as the verdict on the closing clause; what the confound limits is only the',
    'reading of WHY it was not met — the gold measures retrieval of what people attached,',
    'not the labels themselves — which the labeled/unlabeled breakdown is reported to',
    'inform.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Metric math — pure, pinned by literal-valued tests.
// ---------------------------------------------------------------------------

/** Distinct model ids in shortlist order (a model with several versions counts once). */
export function rankedModelIds(entries: readonly Pick<ResourceIntentShortlistEntry, 'modelId'>[]) {
  const seen = new Set<number>();
  const ranked: number[] = [];
  for (const entry of entries) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    ranked.push(entry.modelId);
  }
  return ranked;
}

/** At least one gold id among the first `k` ranked ids. */
export function hitAtK(ranked: readonly number[], gold: ReadonlySet<number>, k: number): boolean {
  return ranked.slice(0, k).some((id) => gold.has(id));
}

/** 1 / (1-based rank of the first gold id within the first `k`), else 0. */
export function reciprocalRankAtK(
  ranked: readonly number[],
  gold: ReadonlySet<number>,
  k: number
): number {
  const index = ranked.slice(0, k).findIndex((id) => gold.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/**
 * Exact two-sided McNemar: with n = b + c discordant pairs, under H0 the smaller count
 * is Binomial(n, 0.5), and p = min(1, 2 * P(X <= min(b, c))). Summed in log space so
 * n in the thousands neither underflows nor overflows. No discordant pairs ⇒ p = 1.
 */
export function exactMcNemarP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const logHalfN = n * Math.log(0.5);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) + logHalfN);
  return Math.min(1, 2 * tail);
}

/** The pre-registered decision rule: b > c AND exact McNemar p < alpha. */
export function purposeBeatsPopularity(b: number, c: number): boolean {
  return b > c && exactMcNemarP(b, c) < M3_RETRIEVAL_PREREGISTRATION.alpha;
}

// ---------------------------------------------------------------------------
// The two arms.
// ---------------------------------------------------------------------------

export type RetrievalArmOpts = {
  browsingLevel: number;
  coverage: ResourceIntentCoverage;
  cap: number;
};

export type RetrievalArmResult = {
  entries: ResourceIntentShortlistEntry[];
  /** PURPOSE only: the label read failed and `entries` is in seed order. */
  insightFallback: boolean;
};

export type RetrievalArm = (
  criteria: ResourceIntentCriteria,
  opts: RetrievalArmOpts
) => Promise<RetrievalArmResult>;

/** PURPOSE: the shipped matcher, untouched — purpose-first seed plus label re-rank. */
export const purposeArm: RetrievalArm = (criteria, opts) =>
  findResourceIntentCandidates(criteria, opts);

/**
 * POPULARITY: the endpoint's own popularity seed page, ALONE. The filter, pool width,
 * baseModels and cap come from `resolveResourceIntentSeedPlan` (shared with the
 * matcher); the page from `buildResourceIntentSeedQueries` (sorted
 * `metrics.thumbsUpCount:desc` only); the fetch from `searchResourceIntentSeedPage`. The
 * `expandShortlist` call repeats the matcher's arguments — a test pins both arms to the
 * same pool and cap. Never handed to the label re-rank, so the only differences from
 * PURPOSE are the seed (no purpose page) and the ordering (no labels).
 */
export const popularityArm: RetrievalArm = async (criteria, opts) => {
  if (criteria.role === 'none') return { entries: [], insightFallback: false };
  const { cap, poolCap, baseModels, filter } = resolveResourceIntentSeedPlan(criteria, opts);
  const { popularity } = buildResourceIntentSeedQueries({ filter, role: criteria.role, poolCap });
  const hits = await searchResourceIntentSeedPage(popularity);
  const pool = expandShortlist(hits, { baseModels, coverage: opts.coverage, cap: poolCap });
  return { entries: pool.slice(0, cap), insightFallback: false };
};

/**
 * The positive control: how many models-index documents carry a non-`none`
 * `insight.role` — the field the PURPOSE page filters on. Read through the same index
 * and the same field the arm reads, so a total projection fault (every document
 * written with a null role) reads 0 here rather than as a null study result.
 */
export async function countLabeledIndexDocuments(): Promise<number> {
  const client = searchClient;
  if (!client) return 0;
  const result = await client.index(MODELS_SEARCH_INDEX).search('', {
    filter: inArray(
      'insight.role',
      RESOURCE_INTENT_ROLE_OPTIONS.filter((role) => role !== 'none')
    ),
    limit: 0,
  });
  return result.estimatedTotalHits ?? 0;
}

/**
 * Which of `modelIds` carry a label the index projection would write: the same
 * `loadResourceInsights` read and `modelInsightProjection` rule the models index uses,
 * applied over each model's versions. ⚠️ Over ALL its versions, where the index passes
 * only the versions it indexes — so a label on an unindexed version counts here. Only
 * STRATIFIES the report; it never decides it.
 */
export async function loadLabeledModelIds(modelIds: readonly number[]): Promise<Set<number>> {
  if (!modelIds.length) return new Set();
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId: { in: [...modelIds] } },
    select: { id: true, modelId: true },
  });
  const insights = await loadResourceInsights(versions.map((v) => v.id));
  const versionsByModel = new Map<number, number[]>();
  for (const v of versions) {
    versionsByModel.set(v.modelId, [...(versionsByModel.get(v.modelId) ?? []), v.id]);
  }
  return new Set(
    [...versionsByModel]
      .filter(([, versionIds]) => modelInsightProjection(versionIds, insights) !== null)
      .map(([modelId]) => modelId)
  );
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export type RetrievalGoldRow = {
  imageId: number;
  prompt: string;
  attachedModels: { modelId: number; modelType: string }[];
  /** Distinct base models of the image's attached Checkpoint versions. */
  checkpointBaseModels: string[];
};

export type RetrievalExclusion =
  | 'stage1_failed'
  | 'role_none'
  | 'no_in_role_attachment'
  | 'arm_error'
  | 'insight_fallback';

export type RetrievalRowOutcome =
  | {
      imageId: number;
      status: RetrievalExclusion;
      role: ResourceIntentRole | null;
      attachedCount: number;
      checkpointCount: number;
      inRoleCount: number;
      detail?: string;
    }
  | {
      imageId: number;
      status: 'scored';
      role: ResourceIntentRole;
      baseModel: string | null;
      attachedCount: number;
      checkpointCount: number;
      inRoleCount: number;
      goldModelIds: number[];
      goldLabeled: boolean;
      purposeModelIds: number[];
      popularityModelIds: number[];
    };

/** The criteria-request baseModel for a row: its one attached checkpoint's, else none. */
export function requestBaseModel(row: RetrievalGoldRow): string | null {
  return row.checkpointBaseModels.length === 1 ? row.checkpointBaseModels[0] : null;
}

/** Attached models whose type the judged role's ModelType filter admits. */
export function inRoleGold(
  row: RetrievalGoldRow,
  role: ResourceIntentRole
): { modelId: number; modelType: string }[] {
  const allowed = ROLE_MODEL_TYPES[role];
  if (!allowed) return [];
  const byId = new Map<number, { modelId: number; modelType: string }>();
  for (const model of row.attachedModels) {
    if ((allowed as readonly string[]).includes(model.modelType)) byId.set(model.modelId, model);
  }
  return [...byId.values()];
}

export async function runRetrievalArms(
  rows: readonly RetrievalGoldRow[],
  deps: {
    /** Stage 1 for one prompt: the intent and the compiled criteria, or null on failure. */
    stage1: (
      prompt: string,
      baseModel: string | null
    ) => Promise<{ intent: ResourceIntentAnswer; criteria: ResourceIntentCriteria } | null>;
    armOpts: RetrievalArmOpts;
    labeledModelIds: ReadonlySet<number>;
    arms?: { purpose: RetrievalArm; popularity: RetrievalArm };
  }
): Promise<RetrievalRowOutcome[]> {
  const arms = deps.arms ?? { purpose: purposeArm, popularity: popularityArm };
  const outcomes: RetrievalRowOutcome[] = [];
  for (const row of rows) {
    const attachedCount = new Set(row.attachedModels.map((m) => m.modelId)).size;
    const checkpointCount = new Set(
      row.attachedModels.filter((m) => m.modelType === 'Checkpoint').map((m) => m.modelId)
    ).size;
    const baseModel = requestBaseModel(row);
    let stage1: Awaited<ReturnType<typeof deps.stage1>>;
    try {
      stage1 = await deps.stage1(row.prompt, baseModel);
    } catch (error) {
      outcomes.push({
        imageId: row.imageId,
        status: 'stage1_failed',
        role: null,
        attachedCount,
        checkpointCount,
        inRoleCount: 0,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!stage1) {
      outcomes.push({
        imageId: row.imageId,
        status: 'stage1_failed',
        role: null,
        attachedCount,
        checkpointCount,
        inRoleCount: 0,
      });
      continue;
    }
    const { criteria } = stage1;
    const role = criteria.role;
    if (role === 'none') {
      outcomes.push({
        imageId: row.imageId,
        status: 'role_none',
        role,
        attachedCount,
        checkpointCount,
        inRoleCount: 0,
      });
      continue;
    }
    const gold = inRoleGold(row, role);
    if (gold.length === 0) {
      outcomes.push({
        imageId: row.imageId,
        status: 'no_in_role_attachment',
        role,
        attachedCount,
        checkpointCount,
        inRoleCount: 0,
      });
      continue;
    }
    // Both arms get the SAME criteria object and the SAME options object.
    let purpose: RetrievalArmResult;
    let popularity: RetrievalArmResult;
    try {
      purpose = await arms.purpose(criteria, deps.armOpts);
      popularity = await arms.popularity(criteria, deps.armOpts);
    } catch (error) {
      outcomes.push({
        imageId: row.imageId,
        status: 'arm_error',
        role,
        attachedCount,
        checkpointCount,
        inRoleCount: gold.length,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (purpose.insightFallback) {
      outcomes.push({
        imageId: row.imageId,
        status: 'insight_fallback',
        role,
        attachedCount,
        checkpointCount,
        inRoleCount: gold.length,
      });
      continue;
    }
    outcomes.push({
      imageId: row.imageId,
      status: 'scored',
      role,
      baseModel,
      attachedCount,
      checkpointCount,
      inRoleCount: gold.length,
      goldModelIds: gold.map((m) => m.modelId),
      goldLabeled: gold.some((m) => deps.labeledModelIds.has(m.modelId)),
      purposeModelIds: rankedModelIds(purpose.entries),
      popularityModelIds: rankedModelIds(popularity.entries),
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Evaluation and report.
// ---------------------------------------------------------------------------

export type ArmComparison = {
  n: number;
  purposeHits: number;
  popularityHits: number;
  /** PURPOSE hit, POPULARITY miss. */
  b: number;
  /** POPULARITY hit, PURPOSE miss. */
  c: number;
  difference: number | null;
  mcnemarP: number;
};

export type RetrievalVerdict = 'MET' | 'NOT MET' | 'VOID';

/** Exclusions caused by infrastructure, not by the prompt. */
const INFRA_EXCLUSIONS = ['stage1_failed', 'arm_error', 'insight_fallback'] as const;
type INFRA_EXCLUSION = (typeof INFRA_EXCLUSIONS)[number];

export type RetrievalEvaluation = {
  params: RetrievalRunParams;
  overrides: string[];
  drawn: number;
  excluded: Record<RetrievalExclusion, number>;
  /**
   * Over rows whose stage 1 produced a non-none role: attached models outside it, and
   * how many of those are checkpoints (no role admits one, so they say nothing about
   * stage 1's role choice).
   */
  outOfRole: { attached: number; excluded: number; checkpoints: number };
  primary: ArmComparison & { purposeBeatsPopularity: boolean };
  secondary: {
    k: number;
    hit: ArmComparison;
    purposeMrr: number | null;
    popularityMrr: number | null;
  };
  strata: { labeled: ArmComparison; unlabeled: ArmComparison };
  /** Scored prompts where the two arms returned the same first-K model ids, in order. */
  identicalAtPrimaryK: number;
  /** The one verdict on the closing clause, and why. */
  verdict: { verdict: RetrievalVerdict; reason: string };
};

/**
 * The pre-registered mapping from an evaluation to exactly one verdict. VOID first —
 * a run that cannot speak to the clause must not reach the decision rule — then MET iff
 * the decision rule holds, else NOT MET.
 */
export function retrievalVerdict(e: {
  overrides: readonly string[];
  drawn: number;
  excluded: Pick<Record<RetrievalExclusion, number>, INFRA_EXCLUSION>;
  primary: Pick<ArmComparison, 'n' | 'b' | 'c'>;
  identicalAtPrimaryK: number;
}): { verdict: RetrievalVerdict; reason: string } {
  const { minScored, maxInfraExclusionFraction } = M3_RETRIEVAL_PREREGISTRATION.voidIf;
  if (e.overrides.length) {
    return {
      verdict: 'VOID',
      reason: `not the registered run (overridden: ${e.overrides.join('; ')})`,
    };
  }
  if (e.primary.n === 0) return { verdict: 'VOID', reason: 'no prompt scored' };
  const infra = INFRA_EXCLUSIONS.reduce((sum, key) => sum + e.excluded[key], 0);
  if (infra > maxInfraExclusionFraction * e.drawn) {
    return {
      verdict: 'VOID',
      reason: `infrastructure exclusions ${infra} of ${e.drawn} drawn exceed ${
        maxInfraExclusionFraction * 100
      }%`,
    };
  }
  if (e.primary.n < minScored) {
    return {
      verdict: 'VOID',
      reason: `${e.primary.n} prompts scored, under the ${minScored} the power calculation assumes`,
    };
  }
  if (e.identicalAtPrimaryK === e.primary.n) {
    return {
      verdict: 'VOID',
      reason: `both arms returned the same first ${M3_RETRIEVAL_PREREGISTRATION.primaryK} model ids on every scored prompt`,
    };
  }
  return purposeBeatsPopularity(e.primary.b, e.primary.c)
    ? {
        verdict: 'MET',
        reason: `b > c and exact McNemar p < ${M3_RETRIEVAL_PREREGISTRATION.alpha}`,
      }
    : {
        verdict: 'NOT MET',
        reason: `the decision rule does not hold (b = ${e.primary.b}, c = ${e.primary.c}); the question is closed as not delivered`,
      };
}

type Scored = Extract<RetrievalRowOutcome, { status: 'scored' }>;

function compareArms(scored: readonly Scored[], k: number): ArmComparison {
  let purposeHits = 0;
  let popularityHits = 0;
  let b = 0;
  let c = 0;
  for (const row of scored) {
    const gold = new Set(row.goldModelIds);
    const p = hitAtK(row.purposeModelIds, gold, k);
    const q = hitAtK(row.popularityModelIds, gold, k);
    if (p) purposeHits++;
    if (q) popularityHits++;
    if (p && !q) b++;
    if (q && !p) c++;
  }
  const n = scored.length;
  return {
    n,
    purposeHits,
    popularityHits,
    b,
    c,
    difference: n ? (purposeHits - popularityHits) / n : null,
    mcnemarP: exactMcNemarP(b, c),
  };
}

export function evaluateRetrieval(
  outcomes: readonly RetrievalRowOutcome[],
  params: RetrievalRunParams = PREREGISTERED_RUN_PARAMS
): RetrievalEvaluation {
  const excluded: Record<RetrievalExclusion, number> = {
    stage1_failed: 0,
    role_none: 0,
    no_in_role_attachment: 0,
    arm_error: 0,
    insight_fallback: 0,
  };
  const scored: Scored[] = [];
  let outOfRoleAttached = 0;
  let outOfRoleExcluded = 0;
  let outOfRoleCheckpoints = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'scored') scored.push(outcome);
    else excluded[outcome.status]++;
    if (outcome.role !== null && outcome.role !== 'none') {
      outOfRoleAttached += outcome.attachedCount;
      outOfRoleExcluded += outcome.attachedCount - outcome.inRoleCount;
      outOfRoleCheckpoints += outcome.checkpointCount;
    }
  }

  const k = M3_RETRIEVAL_PREREGISTRATION.primaryK;
  const primary = compareArms(scored, k);
  const overrides = preregistrationOverrides(params);
  const identicalAtPrimaryK = scored.filter(
    (row) =>
      row.purposeModelIds.slice(0, k).join(',') === row.popularityModelIds.slice(0, k).join(',')
  ).length;

  const secondaryK = M3_RETRIEVAL_PREREGISTRATION.secondaryK;
  const mrr = (pick: (row: Scored) => number[]) =>
    scored.length
      ? scored.reduce(
          (sum, row) => sum + reciprocalRankAtK(pick(row), new Set(row.goldModelIds), secondaryK),
          0
        ) / scored.length
      : null;

  return {
    params,
    overrides,
    drawn: outcomes.length,
    excluded,
    outOfRole: {
      attached: outOfRoleAttached,
      excluded: outOfRoleExcluded,
      checkpoints: outOfRoleCheckpoints,
    },
    primary: { ...primary, purposeBeatsPopularity: purposeBeatsPopularity(primary.b, primary.c) },
    secondary: {
      k: secondaryK,
      hit: compareArms(scored, secondaryK),
      purposeMrr: mrr((row) => row.purposeModelIds),
      popularityMrr: mrr((row) => row.popularityModelIds),
    },
    strata: {
      labeled: compareArms(
        scored.filter((row) => row.goldLabeled),
        k
      ),
      unlabeled: compareArms(
        scored.filter((row) => !row.goldLabeled),
        k
      ),
    },
    identicalAtPrimaryK,
    verdict: retrievalVerdict({
      overrides,
      drawn: outcomes.length,
      excluded,
      primary,
      identicalAtPrimaryK,
    }),
  };
}

export function renderRetrievalReport(
  evaluation: RetrievalEvaluation,
  context: { labeledIndexDocuments: number }
): string {
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const rate = (hits: number, n: number) => pct(n ? hits / n : null);
  const { primary, secondary, strata, excluded, outOfRole } = evaluation;
  const k = M3_RETRIEVAL_PREREGISTRATION.primaryK;
  const { powerAssumption } = M3_RETRIEVAL_PREREGISTRATION;
  const scoredFraction = evaluation.drawn ? primary.n / evaluation.drawn : null;
  const discordantRate = primary.n ? (primary.b + primary.c) / primary.n : null;
  const belowAssumption =
    (scoredFraction !== null && scoredFraction < powerAssumption.scoredFraction) ||
    (discordantRate !== null && discordantRate < powerAssumption.discordantRate);
  const scored = primary.n;
  const comparisonRow = (label: string, cmp: ArmComparison) =>
    `| ${label} | ${cmp.n} | ${rate(cmp.purposeHits, cmp.n)} | ${rate(
      cmp.popularityHits,
      cmp.n
    )} | ${cmp.b} | ${cmp.c} | ${cmp.mcnemarP.toPrecision(3)} |`;
  const lines: string[] = [
    '# Resource-intent gold-set study — two-arm retrieval comparison',
    '',
    ...(evaluation.overrides.length
      ? [
          `> 🔴 **NOT THE PRE-REGISTERED RUN.** Overridden: ${evaluation.overrides.join(
            '; '
          )}. Its verdict is VOID; it does not judge the closing clause.`,
          '',
        ]
      : []),
    `Spec hash: \`${RESOURCE_INTENT_SPEC_HASH.slice(0, 16)}…\`. Positive control: ${
      context.labeledIndexDocuments
    } index documents carry a non-none \`insight.role\` (floor ${
      M3_RETRIEVAL_PREREGISTRATION.labeledIndexFloor
    }).`,
    '',
    `## Verdict: ${evaluation.verdict.verdict}`,
    '',
    `${evaluation.verdict.verdict} — ${evaluation.verdict.reason}.`,
    '',
    '## Pre-registration',
    '',
    '```text',
    renderRetrievalPreregistration(),
    '```',
    '',
    '## Sample',
    '',
    '| | count |',
    '|---|---|',
    `| drawn | ${evaluation.drawn} |`,
    `| excluded: stage-1 failed | ${excluded.stage1_failed} |`,
    `| excluded: role = none | ${excluded.role_none} |`,
    `| excluded: no in-role attachment | ${excluded.no_in_role_attachment} |`,
    `| excluded: an arm errored | ${excluded.arm_error} |`,
    `| excluded: PURPOSE label read fell back | ${excluded.insight_fallback} |`,
    `| **scored** | **${scored}** |`,
    '',
    `Attached models outside the judged role's types (excluded from the gold): ${
      outOfRole.excluded
    } of ${outOfRole.attached} (${rate(
      outOfRole.excluded,
      outOfRole.attached
    )}), over rows whose stage 1 produced a non-none role. Of those, ${
      outOfRole.checkpoints
    } are checkpoints; without them: ${outOfRole.excluded - outOfRole.checkpoints} of ${
      outOfRole.attached - outOfRole.checkpoints
    } (${rate(
      outOfRole.excluded - outOfRole.checkpoints,
      outOfRole.attached - outOfRole.checkpoints
    )}).`,
    '',
    `## Primary: hit@${k}`,
    '',
    '| slice | n | PURPOSE | POPULARITY | b (P hit, Q miss) | c (Q hit, P miss) | McNemar p |',
    '|---|---|---|---|---|---|---|',
    comparisonRow('all scored', primary),
    '',
    `Difference (PURPOSE - POPULARITY): ${pct(primary.difference)}. Decision rule (b > c AND p < ${
      M3_RETRIEVAL_PREREGISTRATION.alpha
    }): ${primary.purposeBeatsPopularity ? 'holds' : 'does not hold'}.`,
    '',
    '## Secondary (not decisive)',
    '',
    '| slice | n | PURPOSE | POPULARITY | b | c | McNemar p |',
    '|---|---|---|---|---|---|---|',
    comparisonRow(`hit@${secondary.k}`, secondary.hit),
    '',
    `MRR@${secondary.k}: PURPOSE ${
      secondary.purposeMrr === null ? '—' : secondary.purposeMrr.toFixed(4)
    }, POPULARITY ${secondary.popularityMrr === null ? '—' : secondary.popularityMrr.toFixed(4)}.`,
    '',
    `## hit@${k} by whether any gold model carries a label (not decisive)`,
    '',
    '| stratum | n | PURPOSE | POPULARITY | b | c | McNemar p |',
    '|---|---|---|---|---|---|---|',
    comparisonRow('gold labeled', strata.labeled),
    comparisonRow('gold unlabeled', strata.unlabeled),
    '',
    '## Diagnostics',
    '',
    `Scored prompts where both arms returned the same first ${k} model ids in the same order: ${evaluation.identicalAtPrimaryK} of ${scored}. If this is ALL of them the arms are indistinguishable at K (the purpose page returned nothing or the label re-rank never moved the head), and the verdict is VOID.`,
    '',
    `Power assumption — scored fraction: ${pct(scoredFraction)} of drawn (assumed >= ${pct(
      powerAssumption.scoredFraction
    )}); discordant rate (b + c) / scored at hit@${k}: ${pct(discordantRate)} (assumed >= ${pct(
      powerAssumption.discordantRate
    )}).${
      belowAssumption
        ? ' 🔴 BELOW THE ASSUMPTION — re-plan the sample size in a new commit before the registered run.'
        : ''
    }`,
    '',
    'Known confound: people attach popular models, so this gold favours POPULARITY. A MET verdict is conservative. A NOT MET verdict stands; the confound limits only the reading of why — the gold measures retrieval of what people attached, not the labels themselves.',
    '',
  ];
  return lines.join('\n');
}
