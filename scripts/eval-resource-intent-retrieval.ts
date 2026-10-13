import { dbRead } from '~/server/db/client';
import { loadResourceInsights, modelInsightProjection } from '~/server/services/resource-insight';
import {
  findResourceIntentCandidates,
  type ResourceIntentCoverage,
  type ResourceIntentShortlistEntry,
} from '~/server/services/resource-intent-matcher.service';
import {
  clampResourceIntentCap,
  RESOURCE_INTENT_SPEC_HASH,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentCriteria,
  type ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';
import {
  exactMcNemarP,
  M3_RETRIEVAL_PREREGISTRATION,
  PREREGISTERED_RUN_PARAMS,
  preregistrationOverrides,
  renderRetrievalPreregistration,
  type RetrievalRunParams,
} from './eval-resource-intent-registration';

/**
 * M3, part two — the two-arm RETRIEVAL comparison, run from
 * `./eval-resource-intent-goldset.ts`.
 *
 * The question: on prompts people actually generated with, does the shipped matcher
 * (PURPOSE arm: the popularity seed re-ranked by the labels) put a resource they really
 * attached near the top more often than that seed alone (POPULARITY arm)?
 *
 * Everything that decides the answer is fixed BEFORE any run, in
 * `M3_RETRIEVAL_PREREGISTRATION` and the text `renderRetrievalPreregistration` builds
 * from it — both in `./eval-resource-intent-registration.ts`.
 *
 * Committed, NOT executed: a live run needs a prod replica read, the models index and
 * an OpenRouter key, and is meant to run only once the matcher it grades is serving
 * from a `release` build.
 */

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

export { exactMcNemarP };

/** Co-primary (i): the one-sided non-inferiority bound on the paired hit@K difference. */
export function nonInferiority(
  n: number,
  b: number,
  c: number
): { n: number; b: number; c: number; d: number; se: number; lower: number; holds: boolean } {
  const { nonInferiorityMargin, nonInferiorityZ } = M3_RETRIEVAL_PREREGISTRATION;
  if (n === 0) return { n, b, c, d: 0, se: 0, lower: 0, holds: false };
  const d = (b - c) / n;
  const se = Math.sqrt(b + c - (b - c) ** 2 / n) / n;
  const lower = d - nonInferiorityZ * se;
  return { n, b, c, d, se, lower, holds: lower > -nonInferiorityMargin };
}

/** Co-primary (ii): the exact two-sided sign test on prompts whose MRR differs. */
export function mrrSignTest(
  up: number,
  down: number
): { up: number; down: number; p: number; holds: boolean } {
  const p = exactMcNemarP(up, down);
  return { up, down, p, holds: up > down && p < M3_RETRIEVAL_PREREGISTRATION.alpha };
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
  /** PURPOSE only: pool versions the re-rank promotes — the positive control's input. */
  promotableVersions?: number;
  /** PURPOSE only: the whole pool it ranked, in seed order — POPULARITY's input. */
  pool?: ResourceIntentShortlistEntry[];
};

export type RetrievalArm = (
  criteria: ResourceIntentCriteria,
  opts: RetrievalArmOpts
) => Promise<RetrievalArmResult>;

/** POPULARITY is derived from PURPOSE's result, so the two arms cannot seed separately. */
export type PopularityArm = (
  purpose: RetrievalArmResult,
  opts: RetrievalArmOpts
) => RetrievalArmResult | Promise<RetrievalArmResult>;

/** PURPOSE: the shipped matcher, untouched — popularity seed plus label re-rank. */
export const purposeArm: RetrievalArm = (criteria, opts) =>
  findResourceIntentCandidates(criteria, opts);

/**
 * POPULARITY: the pool PURPOSE ranked, in seed order, cut to the same cap and never
 * handed to the label re-rank. One seed per prompt, so the only difference from PURPOSE
 * is `applyInsightRanking`.
 */
export const popularityArm: PopularityArm = (purpose, opts) => ({
  entries: (purpose.pool ?? []).slice(0, clampResourceIntentCap(opts.cap)),
  insightFallback: false,
});

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
      /** PURPOSE's pool held at least one version the re-rank promotes. */
      promotable: boolean;
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
    arms?: { purpose: RetrievalArm; popularity: PopularityArm };
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
      popularity = await arms.popularity(purpose, deps.armOpts);
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
      promotable: (purpose.promotableVersions ?? 0) > 0,
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
  primary: ArmComparison;
  /** Co-primary (i). */
  nonInferiority: ReturnType<typeof nonInferiority>;
  /** Co-primary (ii). */
  mrr: ReturnType<typeof mrrSignTest>;
  /** Scored prompts whose PURPOSE pool held a version the re-rank promotes. */
  promotableScored: number;
  secondary: {
    k: number;
    hit: ArmComparison;
    purposeMrr: number | null;
    popularityMrr: number | null;
  };
  strata: { labeled: ArmComparison; unlabeled: ArmComparison };
  /** Diagnostic only: scored prompts where the two arms returned the same first-K ids. */
  identicalAtPrimaryK: number;
  /** The one verdict on the closing clause, and why. */
  verdict: { verdict: RetrievalVerdict; reason: string };
};

/**
 * The pre-registered mapping from an evaluation to exactly one verdict. VOID first —
 * a run that cannot speak to the clause must not reach the co-primaries — then MET iff
 * both co-primaries hold, else NOT MET.
 */
export function retrievalVerdict(e: {
  overrides: readonly string[];
  drawn: number;
  excluded: Pick<Record<RetrievalExclusion, number>, INFRA_EXCLUSION>;
  n: number;
  promotableScored: number;
  nonInferiority: Pick<ReturnType<typeof nonInferiority>, 'lower' | 'holds'>;
  mrr: Pick<ReturnType<typeof mrrSignTest>, 'up' | 'down' | 'p' | 'holds'>;
}): { verdict: RetrievalVerdict; reason: string } {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const { minScored, maxInfraExclusionFraction } = p.voidIf;
  if (e.overrides.length) {
    return {
      verdict: 'VOID',
      reason: `not the registered run (overridden: ${e.overrides.join('; ')})`,
    };
  }
  if (e.n === 0) return { verdict: 'VOID', reason: 'no prompt scored' };
  const infra = INFRA_EXCLUSIONS.reduce((sum, key) => sum + e.excluded[key], 0);
  if (infra > maxInfraExclusionFraction * e.drawn) {
    return {
      verdict: 'VOID',
      reason: `infrastructure exclusions ${infra} of ${e.drawn} drawn exceed ${
        maxInfraExclusionFraction * 100
      }%`,
    };
  }
  if (e.n < minScored) {
    return {
      verdict: 'VOID',
      reason: `${e.n} prompts scored, under the ${minScored}-prompt floor (the scored-fraction floor rule carried from v2)`,
    };
  }
  if (e.promotableScored / e.n < p.minPromotableFraction) {
    return {
      verdict: 'VOID',
      reason: `positive control failed: ${e.promotableScored} of ${
        e.n
      } scored prompts had a pool version the re-rank promotes, under ${
        p.minPromotableFraction * 100
      }%`,
    };
  }
  const parts = [
    `(i) non-inferiority ${
      e.nonInferiority.holds ? 'holds' : 'does not hold'
    } (lower bound ${e.nonInferiority.lower.toFixed(4)} vs -${p.nonInferiorityMargin})`,
    `(ii) MRR@${p.secondaryK} superiority ${e.mrr.holds ? 'holds' : 'does not hold'} (up ${
      e.mrr.up
    }, down ${e.mrr.down}, p ${e.mrr.p.toPrecision(3)})`,
  ].join('; ');
  return e.nonInferiority.holds && e.mrr.holds
    ? { verdict: 'MET', reason: parts }
    : {
        verdict: 'NOT MET',
        reason: `${parts}; the question is closed as not delivered for this matcher`,
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
  const rr = (row: Scored, ids: number[]) =>
    reciprocalRankAtK(ids, new Set(row.goldModelIds), secondaryK);
  const mrr = (pick: (row: Scored) => number[]) =>
    scored.length ? scored.reduce((sum, row) => sum + rr(row, pick(row)), 0) / scored.length : null;
  let up = 0;
  let down = 0;
  for (const row of scored) {
    const purposeRr = rr(row, row.purposeModelIds);
    const popularityRr = rr(row, row.popularityModelIds);
    if (purposeRr > popularityRr) up++;
    else if (popularityRr > purposeRr) down++;
  }
  const nonInferiorityResult = nonInferiority(primary.n, primary.b, primary.c);
  const mrrResult = mrrSignTest(up, down);
  const promotableScored = scored.filter((row) => row.promotable).length;

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
    primary,
    nonInferiority: nonInferiorityResult,
    mrr: mrrResult,
    promotableScored,
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
      n: primary.n,
      promotableScored,
      nonInferiority: nonInferiorityResult,
      mrr: mrrResult,
    }),
  };
}

export function renderRetrievalReport(
  evaluation: RetrievalEvaluation,
  context: { coverage?: ResourceIntentCoverage }
): string {
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const rate = (hits: number, n: number) => pct(n ? hits / n : null);
  const { primary, secondary, strata, excluded, outOfRole } = evaluation;
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const k = p.primaryK;
  const ni = evaluation.nonInferiority;
  const mrr = evaluation.mrr;
  const scored = primary.n;
  const isPilot = evaluation.overrides.length > 0;
  const scoredFraction = evaluation.drawn ? scored / evaluation.drawn : null;
  const discordantRate = scored ? (primary.b + primary.c) / scored : null;
  const nonTieRate = scored ? (mrr.up + mrr.down) / scored : null;
  const planned = {
    scoredFraction: p.planning.scored / p.sampleSize,
    discordantRate: p.planning.hitDiscordant / p.planning.hitDiscordantOf,
    nonTieRate: p.planning.mrrNonTieRate,
  };
  const belowPlanning =
    (scoredFraction !== null && scoredFraction < planned.scoredFraction) ||
    (discordantRate !== null && discordantRate < planned.discordantRate) ||
    (nonTieRate !== null && nonTieRate < planned.nonTieRate);
  const comparisonRow = (label: string, cmp: ArmComparison) =>
    `| ${label} | ${cmp.n} | ${rate(cmp.purposeHits, cmp.n)} | ${rate(
      cmp.popularityHits,
      cmp.n
    )} | ${cmp.b} | ${cmp.c} | ${cmp.mcnemarP.toPrecision(3)} |`;
  const lines: string[] = [
    '# Resource-intent gold-set study — two-arm retrieval comparison',
    '',
    ...(isPilot
      ? [
          `> 🔴 **NOT THE PRE-REGISTERED RUN.** Overridden: ${evaluation.overrides.join(
            '; '
          )}. Its verdict is VOID; it does not judge the closing clause.`,
          '',
        ]
      : []),
    `Registration: v${p.version} (registered ${
      p.registeredOn
    }). Spec hash: \`${RESOURCE_INTENT_SPEC_HASH.slice(0, 16)}…\`.${
      context.coverage
        ? ` Coverage (resolved as the endpoint does, for an anonymous caller): next=${context.coverage.next}, member=${context.coverage.member}.`
        : ''
    }`,
    '',
    `## Co-primary (i): non-inferiority on hit@${k}`,
    '',
    `n = ${ni.n}, b = ${ni.b}, c = ${ni.c}; d = (b - c) / n = ${ni.d.toFixed(
      4
    )}; se = sqrt(b + c - (b - c)^2 / n) / n = ${ni.se.toFixed(4)}; lower bound d - ${
      p.nonInferiorityZ
    } * se = ${ni.lower.toFixed(4)} against -${p.nonInferiorityMargin}: ${
      ni.holds ? 'holds' : 'does not hold'
    }.`,
    '',
    `## Co-primary (ii): superiority on MRR@${p.secondaryK}`,
    '',
    `Prompts whose reciprocal rank @${p.secondaryK} differs: up (PURPOSE higher) = ${
      mrr.up
    }, down (POPULARITY higher) = ${mrr.down}; exact two-sided p = ${mrr.p.toPrecision(
      3
    )} against ${p.alpha}: ${mrr.holds ? 'holds' : 'does not hold'}.`,
    '',
    `Positive control: ${evaluation.promotableScored} of ${scored} scored prompts (${rate(
      evaluation.promotableScored,
      scored
    )}) had at least one pool version the re-rank promotes (VOID under ${(
      p.minPromotableFraction * 100
    ).toFixed(0)}%).`,
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
    `## hit@${k} per arm`,
    '',
    '| slice | n | PURPOSE | POPULARITY | b (P hit, Q miss) | c (Q hit, P miss) | McNemar p |',
    '|---|---|---|---|---|---|---|',
    comparisonRow('all scored', primary),
    '',
    `Difference (PURPOSE - POPULARITY): ${pct(primary.difference)}.`,
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
    `Scored prompts where both arms returned the same first ${k} model ids in the same order: ${evaluation.identicalAtPrimaryK} of ${scored}. A diagnostic only — the arms differ only by the re-rank, so identical heads are expected on most prompts; it never voids a run.`,
    '',
    `Planning assumptions — scored fraction: ${pct(scoredFraction)} of drawn (planned ${pct(
      planned.scoredFraction
    )}); hit@${k} discordant rate: ${pct(discordantRate)} (planned ${pct(
      planned.discordantRate
    )}); MRR@${p.secondaryK} non-tie rate: ${pct(nonTieRate)} (planned ${pct(
      planned.nonTieRate
    )}).${
      isPilot && belowPlanning
        ? ' 🔴 BELOW THE PLANNING ASSUMPTION — re-plan the sample size in a new commit before the registered run.'
        : ''
    }`,
    '',
    'Known confound: people attach popular models, so this gold favours POPULARITY. A MET verdict is conservative. A NOT MET verdict stands; the confound limits only the reading of why — the gold measures retrieval of what people attached, not the labels themselves.',
    '',
  ];
  return lines.join('\n');
}
