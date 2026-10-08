import { Prisma } from '@prisma/client';
import { RESOURCE_INTENT_DEFAULT_LIMIT } from '~/server/schema/resource-intent.schema';

/**
 * M3's registration: the pre-registered constants, the text built from them, the pure
 * statistics that text and the verdict share, v2's superseded record, and the committed
 * gold-set queries.
 *
 * 🔴 KEEP THIS MODULE FREE OF DATABASE AND SEARCH CLIENTS. The dry run
 * (`scripts/eval-resource-intent-goldset.ts` without `--execute`) imports only this, so it
 * runs on a host with no Prisma engine and no search index. `Prisma.sql` is a template
 * builder from `@prisma/client`; it constructs no client.
 */

/**
 * 🔴 REGISTRATION v2 — SUPERSEDED, KEPT VERBATIM AS THE RECORD. Its registered run judged
 * the then-shipped purpose-first matcher NOT MET, and that verdict is binding. Nothing reads
 * these constants or `renderRetrievalPreregistrationV2` at runtime; the running registration
 * is `M3_RETRIEVAL_PREREGISTRATION` (v3) below. Do not edit either.
 *
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
 *     pilot measures them, and the report prints both against these values. The
 *     corrected 2026-10-06 pilot measured 85.0% scored and 17.6% discordant — both above
 *     the assumption, so nothing here was re-planned (≈150 expected discordant pairs at
 *     1000 drawn; power 0.955 against 65/35, needing 88 of 150). The cost is
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
export const M3_RETRIEVAL_PREREGISTRATION_V2 = {
  version: 2,
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

/** Registration v2's text, verbatim — the record, never printed by a run. */
export function renderRetrievalPreregistrationV2(): string {
  const p = M3_RETRIEVAL_PREREGISTRATION_V2;
  const k = p.primaryK;
  return [
    `M3 RETRIEVAL PRE-REGISTRATION v${p.version} (registered ${p.registeredOn}, before any registered run)`,
    '',
    'History: v1 was registered 2026-10-06. Its first pilot (2026-10-06,',
    `--retrieval-sample ${p.pilotSampleSize}) ran with feature-flag evaluation failing (Flipt`,
    'unreachable), so coverage fell back to flag defaults instead of resolving as the',
    'endpoint does; that pilot was DISCARDED and none of its measurements are used here.',
    'The corrected pilot (2026-10-06, the same command with Flipt reachable, coverage',
    'resolved live) measured 85.0% scored and a 17.6% hit@10 discordant rate. Both meet',
    'the power assumption below, so the sample size and both VOID floors are unchanged',
    'from v1. At those rates 1000 drawn gives ~150 expected discordant pairs; exact',
    'two-sided McNemar at 0.05 then needs 88 of 150, and power against the 65/35',
    "alternative is 0.955. The pilot's direction (b vs c) played no part in any choice in",
    'this registration.',
    'v2 differs from v1 ONLY in: the run aborts unless the coverage flags are evaluated by',
    'a live Flipt client (below); the report prints the resolved coverage; this History',
    'text; and the header now reads "before any registered run".',
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
    `resolved as the endpoint does and printed in the report) and cap (${p.cap}).`,
    'PURPOSE = findResourceIntentCandidates',
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
    `            arms returned the same first ${k} model ids on every scored prompt. Two`,
    '            checks abort before any index read or vendor call, so they produce no',
    '            report at all: coverage flags not evaluated by a live Flipt client (Flipt',
    '            unreachable, a flag missing, or a coverage flag set in',
    '            FLIPT_LOCAL_OVERRIDES — any of which is not the endpoint), and a failed',
    '            positive control.',
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
// Pure statistics. They live here, not in the retrieval module, so the dry run can print
// the power statement without loading a database or search client.
// ---------------------------------------------------------------------------

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/**
 * Exact two-sided McNemar: with n = b + c discordant pairs, under H0 the smaller count
 * is Binomial(n, 0.5), and p = min(1, 2 * P(X <= min(b, c))). Summed in log space so
 * n in the thousands neither underflows nor overflows. No discordant pairs ⇒ p = 1.
 * Also the exact two-sided sign test on (up, down).
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

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, absolute error < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * 🔴 REGISTRATION v3 — the running registration. Changing any value after a run has been
 * seen turns the study into a fishing expedition; the CLI may override `sampleSize` and
 * `sampleDays` (the pilot), which stamps the report as not the registered run and VOIDs it.
 *
 * - `nonInferiorityMargin` / `nonInferiorityZ`: co-primary (i), a one-sided 95% bound on
 *   the paired hit@`primaryK` difference.
 * - `alpha`: co-primary (ii), the exact two-sided sign test on MRR@`secondaryK`.
 * - `minPromotableFraction`: the positive control on what PURPOSE actually reads — the
 *   share of scored prompts whose pool held at least one version the re-rank promotes.
 * - `planning`: power-planning inputs. Assumptions, not evidence; they decide nothing.
 *   `scored` is `sampleSize` × the pilot's scored fraction; `hitDiscordant` /
 *   `hitDiscordantOf` and `mrrNonTieRate` are the pilot's other NUISANCE rates (counts in
 *   `replan.pilot`). `mrrPurposeShare`, the only effect-size input, is
 *   still the offline replay's value — the pilot's effect estimate is not used.
 *   `v2PopularityHitRate` sizes the margin sentence; `replayDesigns` / `replayPrompts`
 *   are the replay's provenance, quoted in the Selection sentence.
 * - `replan`: the one re-plan, made 2026-10-07 before any registered run under the
 *   pilot rule the text states — the pilot's nuisance counts (`pilot`) and the values the
 *   re-plan replaced (`from`). Printed, never read by the verdict.
 */
export const M3_RETRIEVAL_PREREGISTRATION = {
  version: 3,
  registeredOn: '2026-10-07',
  primaryK: 10,
  secondaryK: RESOURCE_INTENT_DEFAULT_LIMIT,
  alpha: 0.05,
  nonInferiorityMargin: 0.02,
  nonInferiorityZ: 1.645,
  sampleSize: 2000,
  sampleDays: 30,
  cap: RESOURCE_INTENT_DEFAULT_LIMIT,
  minPromotableFraction: 0.1,
  planning: {
    scored: 1600,
    hitDiscordant: 8,
    hitDiscordantOf: 80,
    mrrNonTieRate: 0.275,
    mrrPurposeShare: 0.68,
    v2PopularityHitRate: 0.113,
    replayDesigns: 18,
    replayPrompts: 254,
  },
  replan: {
    replannedOn: '2026-10-07',
    pilot: { scored: 80, hitDiscordant: 8, mrrNonTies: 22 },
    from: {
      sampleSize: 1000,
      minScored: 667,
      planningScored: 822,
      hitDiscordant: 13,
      hitDiscordantOf: 254,
      mrrNonTieRate: 0.134,
    },
  },
  voidIf: { minScored: 1334, maxInfraExclusionFraction: 0.1 },
  pilotSampleSize: 100,
} as const;

/** P(X <= k) for X ~ Binomial(n, p), 0 < p < 1, summed in log space. */
function binomialCdf(k: number, n: number, prob: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(logChoose(n, i) + i * Math.log(prob) + (n - i) * Math.log(1 - prob));
  }
  return sum;
}

/**
 * The exact (Clopper-Pearson) two-sided 1 - `alpha` interval for a binomial proportion
 * k / n: lower solves P(X >= k) = alpha / 2, upper solves P(X <= k) = alpha / 2, each by
 * bisection (both tails are monotone in p). k = 0 gives lower 0; k = n gives upper 1.
 */
export function clopperPearson(k: number, n: number, alpha: number) {
  const solve = (tooHigh: (prob: number) => boolean) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (tooHigh(mid)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const lower = k === 0 ? 0 : solve((prob) => 1 - binomialCdf(k - 1, n, prob) >= alpha / 2);
  const upper = k === n ? 1 : solve((prob) => binomialCdf(k, n, prob) <= alpha / 2);
  return { lower, upper };
}

/** One-sided non-inferiority power at a true difference of 0: se = sqrt(discordant rate / n). */
function nonInferiorityPowerAt(discordantRate: number, n: number): number {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  return 1 - normalCdf(p.nonInferiorityZ - p.nonInferiorityMargin / Math.sqrt(discordantRate / n));
}

/**
 * Power of co-primary (ii): the probability that an exact two-sided sign test over
 * `nonTies` prompts finds up > down at p < `alpha`, when each non-tie favours PURPOSE
 * with probability `purposeShare`.
 */
export function mrrSignTestPower(nonTies: number, purposeShare: number): number {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  let power = 0;
  for (let up = 0; up <= nonTies; up++) {
    const down = nonTies - up;
    if (up > down && exactMcNemarP(up, down) < p.alpha) {
      power += Math.exp(
        logChoose(nonTies, up) + up * Math.log(purposeShare) + down * Math.log(1 - purposeShare)
      );
    }
  }
  return power;
}

/**
 * The planned power of each co-primary, derived from `planning` — plus, for the re-plan
 * record only, (i)'s power at the replaced sample size under the same pilot rates.
 */
export function plannedPower() {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const { scored, hitDiscordant, hitDiscordantOf, mrrNonTieRate, mrrPurposeShare } = p.planning;
  const hitDiscordantRate = hitDiscordant / hitDiscordantOf;
  const hitSe = Math.sqrt(hitDiscordantRate / scored);
  const nonInferiorityPower = nonInferiorityPowerAt(hitDiscordantRate, scored);
  const floorHitSe = Math.sqrt(hitDiscordantRate / p.voidIf.minScored);
  const nonInferiorityPowerAtFloor = nonInferiorityPowerAt(hitDiscordantRate, p.voidIf.minScored);
  // The design the re-plan replaced, at the pilot's rates: what (i) would have had.
  const previousScored = Math.round(
    (p.replan.from.sampleSize * p.replan.pilot.scored) / p.pilotSampleSize
  );
  const previousNonInferiorityPower = nonInferiorityPowerAt(hitDiscordantRate, previousScored);
  // The planning discordance is an estimate from the pilot's counts; (i)'s power at the
  // bounds of its exact 95% interval. A LOWER rate means a smaller se, so HIGHER power.
  const hitDiscordantCi = clopperPearson(p.replan.pilot.hitDiscordant, p.replan.pilot.scored, 0.05);
  const nonInferiorityPowerAtCiLower = nonInferiorityPowerAt(hitDiscordantCi.lower, scored);
  const nonInferiorityPowerAtCiLowerFloor = nonInferiorityPowerAt(
    hitDiscordantCi.lower,
    p.voidIf.minScored
  );
  const nonInferiorityPowerAtCiUpper = nonInferiorityPowerAt(hitDiscordantCi.upper, scored);
  const nonInferiorityPowerAtCiUpperFloor = nonInferiorityPowerAt(
    hitDiscordantCi.upper,
    p.voidIf.minScored
  );
  const mrrNonTies = Math.round(scored * mrrNonTieRate);
  const mrrPower = mrrSignTestPower(mrrNonTies, mrrPurposeShare);
  return {
    hitDiscordantRate,
    hitSe,
    nonInferiorityPower,
    floorHitSe,
    nonInferiorityPowerAtFloor,
    previousScored,
    previousNonInferiorityPower,
    hitDiscordantCi,
    nonInferiorityPowerAtCiLower,
    nonInferiorityPowerAtCiLowerFloor,
    nonInferiorityPowerAtCiUpper,
    nonInferiorityPowerAtCiUpperFloor,
    mrrNonTies,
    mrrPower,
  };
}

/**
 * The running pre-registration as text — printed by the dry run and at the top of every
 * report. Built from the constants so the text cannot state a value the code does not use.
 */
export function renderRetrievalPreregistration(): string {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const k = p.primaryK;
  const k2 = p.secondaryK;
  const r = p.replan;
  const power = plannedPower();
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return [
    `M3 RETRIEVAL PRE-REGISTRATION v${p.version} (registered ${p.registeredOn}, before any registered run)`,
    '',
    'History: v1 and v2 were registered 2026-10-06; v2 changed only how the run resolves',
    'coverage. The v2 registered run judged the then-shipped purpose-first matcher (a',
    'role-filtered, quality-sorted seed page with a popularity fill, then the label re-rank)',
    'NOT MET. That verdict is binding: the purpose-first seed is not delivered. v2 is kept',
    'verbatim as renderRetrievalPreregistrationV2 in',
    'scripts/eval-resource-intent-registration.ts. The shipped matcher has since changed: it',
    'seeds from the popularity page alone, and the label re-rank is the only place the',
    'labels act. v3 asks a new question of that matcher; it is not a re-run of v2.',
    '',
    `Selection: this matcher and this decision rule were chosen from an offline`,
    `${p.planning.replayPrompts}-prompt replay that screened ${p.planning.replayDesigns} seed x ranker designs and kept the only one that`,
    `tied popularity on hit@${k} and led it on MRR@${k2}. The MRR@${k2} purpose share in the planning`,
    `figures below (${pct(p.planning.mrrPurposeShare)}) comes from that same best-of-${
      p.planning.replayDesigns
    } screen and is therefore optimistic.`,
    '',
    "Scope: v3 judges THIS design under THIS rule. A v3 MET does not revise v2's binding NOT",
    'MET on whether the purpose-first seed beats popularity.',
    '',
    'Question: does the shipped matcher (PURPOSE arm: popularity seed + label re-rank) do at',
    `least as well as the popularity seed alone (POPULARITY arm) on hit@${k}, while ranking`,
    'attached resources higher?',
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
    `resolved as the endpoint does and printed in the report) and cap (${p.cap}).`,
    'PURPOSE = findResourceIntentCandidates (popularity seed + label re-rank). POPULARITY =',
    'the pool that same call ranked, cut to the cap, with no label ordering. One seed per',
    'prompt, so the arms share one pool and differ only by the re-rank.',
    '',
    'Co-primary. BOTH must hold for MET (intersection-union; alpha is not split):',
    `  (i)  Non-inferiority on hit@${k}, margin ${p.nonInferiorityMargin} absolute. n = scored prompts,`,
    `       b = PURPOSE hit and POPULARITY miss, c = the reverse, d = (b - c) / n,`,
    '       se = sqrt(b + c - (b - c)^2 / n) / n. Holds iff',
    `       d - ${p.nonInferiorityZ} * se > -${p.nonInferiorityMargin} (one-sided 95%). If b + c = 0, se = 0 and the`,
    '       bound is 0.',
    `  (ii) Superiority on MRR@${k2}, by an exact two-sided sign test over the scored prompts`,
    `       whose reciprocal rank @${k2} differs between the arms: up = PURPOSE higher, down =`,
    `       POPULARITY higher. Holds iff up > down AND the exact two-sided p on (up, down)`,
    `       is < ${p.alpha}.`,
    '',
    'Verdict on the closing clause — every run reports exactly one:',
    '  MET     — (i) and (ii) both hold.',
    '  NOT MET — either does not. The closing clause is judged not met for this matcher;',
    '            any follow-up is new work under a new registration, not a re-run.',
    `  VOID    — no verdict, if ANY of: a registered value was overridden (including the`,
    `            ${p.pilotSampleSize}-prompt pilot); fewer than ${p.voidIf.minScored} prompts scored (the scored-fraction`,
    `            floor rule carried from v2: ${p.sampleSize} drawn x ${(
      (p.voidIf.minScored / p.sampleSize) *
      100
    ).toFixed(1)}%); infrastructure`,
    `            exclusions (stage-1 failure, arm error, label-read fallback) exceed ${(
      p.voidIf.maxInfraExclusionFraction * 100
    ).toFixed(0)}%`,
    '            of drawn prompts; or the positive control fails. VOID takes precedence over',
    '            both co-primaries. One check aborts before any index read or vendor call and',
    '            produces no report: coverage flags not evaluated by a live Flipt client',
    '            (Flipt unreachable, a flag missing, or a coverage flag set in',
    '            FLIPT_LOCAL_OVERRIDES — any of which is not the endpoint).',
    '',
    `Positive control: VOID if fewer than ${(p.minPromotableFraction * 100).toFixed(
      0
    )}% of scored prompts have at least one pool version`,
    'the re-rank promotes — a ResourceInsight label at or above the promote-confidence',
    'floor that agrees with the request on role or style family. Without one the re-rank',
    'can still demote, but has nothing it could promote — and ranking attached resources',
    'HIGHER is what the question asks of it.',
    '',
    `No identical-head rule: v2 voided a run whose arms returned the same first ${k} model ids`,
    'on every scored prompt. The arms now differ only by the re-rank, which moves nothing',
    'on a prompt whose pool holds no label it promotes or demotes, so identical heads are',
    'expected on most prompts. (The offline replay is a proxy, not a count of identical',
    "heads: the arms' reciprocal ranks @50 tied on 220 of its 254 prompts.)",
    'The count is printed as a diagnostic only, so it can neither void nor bias a run; the',
    'positive control is what catches a re-rank with nothing to act on.',
    '',
    `Secondary (reported, never decisive): hit@${k2}, mean MRR@${k2} per arm, and hit@${k}`,
    'stratified by whether any gold model carries a non-stale ResourceInsight label at or',
    'above the promote-confidence floor the index projection applies.',
    '',
    'Excluded and counted, never scored: a stage-1 failure, role = none, no in-role',
    'attachment, either arm erroring, and a PURPOSE label read that fell back.',
    '',
    `Power (planning assumptions, NOT evidence; from the ${p.pilotSampleSize}-prompt pilot's nuisance rates, re-planned ${r.replannedOn}):`,
    `hit@${k} discordance ${p.planning.hitDiscordant} of ${
      p.planning.hitDiscordantOf
    } pilot-scored = ${pct(power.hitDiscordantRate)}. The planning n is ${
      p.planning.scored
    } scored: ${p.sampleSize} drawn x the`,
    `pilot's scored fraction (${r.pilot.scored} of ${p.pilotSampleSize} = ${pct(
      r.pilot.scored / p.pilotSampleSize
    )}).`,
    `There se = sqrt(${power.hitDiscordantRate.toFixed(4)} / ${
      p.planning.scored
    }) = ${power.hitSe.toFixed(
      4
    )}, so power for (i) at a true difference of 0 is ${power.nonInferiorityPower.toFixed(2)}.`,
    `At the ${p.voidIf.minScored} floor se = ${power.floorHitSe.toFixed(
      4
    )} and that power is ${power.nonInferiorityPowerAtFloor.toFixed(
      2
    )}: a binding NOT MET from a run scoring between ${p.voidIf.minScored} and ${
      p.planning.scored
    }`,
    'prompts is lower-powered than planned.',
    `That ${power.nonInferiorityPower.toFixed(2)} holds only at the pilot's point estimate of ${
      r.pilot.hitDiscordant
    } of ${r.pilot.scored}. The exact (Clopper-Pearson)`,
    `95% interval for that rate is ${pct(power.hitDiscordantCi.lower)} to ${pct(
      power.hitDiscordantCi.upper
    )}; across it, power for (i) runs from ${power.nonInferiorityPowerAtCiLower.toFixed(2)} down`,
    `to ${power.nonInferiorityPowerAtCiUpper.toFixed(2)} at ${
      p.planning.scored
    } scored, and from ${power.nonInferiorityPowerAtCiLowerFloor.toFixed(
      2
    )} down to ${power.nonInferiorityPowerAtCiUpperFloor.toFixed(2)} at the ${
      p.voidIf.minScored
    } floor.`,
    `MRR@${k2} non-ties ${pct(p.planning.mrrNonTieRate)} of scored (the pilot's ${
      r.pilot.mrrNonTies
    } of ${r.pilot.scored}; ${power.mrrNonTies} of ${p.planning.scored}) with ${pct(
      p.planning.mrrPurposeShare
    )} favouring PURPOSE`,
    `(the replay's planning value, not the pilot's) gives power for (ii) of ${power.mrrPower.toFixed(
      2
    )}.`,
    `The margin: ${
      p.nonInferiorityMargin
    } is absolute against a hit@${k} base rate of about 10-11% (v2: ${pct(
      p.planning.v2PopularityHitRate
    )} for POPULARITY),`,
    `so a relative loss of up to ${(
      (p.nonInferiorityMargin / p.planning.v2PopularityHitRate) *
      100
    ).toFixed(0)}% — roughly one hit in five — would still pass (i).`,
    'The pilot rule, as registered: the pilot re-measures the scored fraction and',
    'both rates; a shortfall there means re-planning in a new commit, never after the run.',
    '',
    `Re-plan (${r.replannedOn}, once, before any registered run): only the VOID ${p.pilotSampleSize}-prompt pilot`,
    `has run under v3. It measured a scored fraction of ${pct(
      r.pilot.scored / p.pilotSampleSize
    )} (planned ${pct(r.from.planningScored / r.from.sampleSize)}), a hit@${k}`,
    `discordance of ${pct(r.pilot.hitDiscordant / r.pilot.scored)} (planned ${
      r.from.hitDiscordant
    } of ${r.from.hitDiscordantOf} = ${pct(
      r.from.hitDiscordant / r.from.hitDiscordantOf
    )}) and an MRR@${k2} non-tie rate of ${pct(r.pilot.mrrNonTies / r.pilot.scored)}`,
    `(planned ${pct(r.from.mrrNonTieRate)}). At those point estimates ${
      r.from.sampleSize
    } drawn scores ~${
      power.previousScored
    } and power for (i) is ${power.previousNonInferiorityPower.toFixed(2)}, so under the`,
    'pilot rule above the sample was re-planned in a new commit:',
    `  sample ${r.from.sampleSize} -> ${p.sampleSize} drawn; VOID floor ${r.from.minScored} -> ${
      p.voidIf.minScored
    } scored (the same ${pct(p.voidIf.minScored / p.sampleSize)} scored-fraction rule);`,
    `  planning n ${r.from.planningScored} -> ${
      p.planning.scored
    } scored; hit@${k} discordance ${pct(r.from.hitDiscordant / r.from.hitDiscordantOf)} -> ${pct(
      power.hitDiscordantRate
    )}; MRR@${k2} non-tie rate ${pct(r.from.mrrNonTieRate)} -> ${pct(p.planning.mrrNonTieRate)}.`,
    `Only the pilot's nuisance rates (scored fraction, hit@${k} discordance, MRR@${k2} non-tie`,
    "rate) were used. The pilot's effect estimate — the direction or size of either",
    `co-primary — was NOT used; the MRR@${k2} purpose share stays at its planning value ${pct(
      p.planning.mrrPurposeShare
    )}.`,
    'The question, the arms, both co-primaries, the margin, alpha, the other VOID rules, the',
    'positive control and the registration date are unchanged.',
    '',
    'Known confound: people attach popular models, so attached-resource gold is biased',
    'TOWARD the POPULARITY arm. A MET verdict is therefore conservative. A NOT MET verdict',
    'stands as the verdict on the closing clause; the confound limits only the reading of',
    'WHY — the gold measures retrieval of what people attached, not the labels themselves —',
    'which the labeled/unlabeled breakdown is reported to inform.',
  ].join('\n');
}

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
 * The committed gold-set queries — reviewable and re-runnable as written.
 *
 * 🔴 Camel-case columns MUST be double-quoted: Postgres folds an unquoted identifier
 * to lower case, so the original `i.hideMeta` / `mv.baseModel` resolved to columns
 * that do not exist (42703) and both queries would have failed on their first
 * execution. The enum is cast to text because a raw query cannot deserialize an enum
 * ARRAY.
 *
 * Which images may enter the study at all — and so have their prompt sent to the
 * vendor: the conditions of `imageWhere` in `src/server/search-index/images.search-index.ts`
 * (the publicly searchable image: not in a review queue, not ToS-violating, minor or POI,
 * in a post that is published, not scheduled, and neither Private nor Unsearchable),
 * plus public meta, a non-empty prompt, no `blockedFor`, the window, and NO attached model
 * flagged POI or minor — an image's own `poi`/`minor` flags are derived from its models
 * only at scan time, so a model flagged since does not reach them.
 * ⚠️ `ingestion = 'Scanned'` is deliberately STRICTER than `imageWhere`'s
 * `imageReviewedSql()`, which also admits locked-rating images whose scan never ran — do
 * not "align" it. Requires the caller to join `"Post" p ON p.id = i."postId"`. One
 * fragment, used by both queries.
 */
const GOLDSET_ELIGIBLE_IMAGE = (days: number) => Prisma.sql`
      i."createdAt" > now() - make_interval(days => ${days}::int)
  AND i."hideMeta" = false
  AND length(i.meta->>'prompt') > 0
  AND i.ingestion = 'Scanned'
  AND i."tosViolation" = false
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i.minor = false
  AND i.poi = false
  AND p."publishedAt" IS NOT NULL
  AND p."publishedAt" <= now()
  AND p.availability != 'Private'::"Availability"
  AND p.availability != 'Unsearchable'::"Availability"
  AND NOT EXISTS (
    SELECT 1
    FROM "ImageResourceNew" fr
    JOIN "ModelVersion" fmv ON fmv.id = fr."modelVersionId"
    JOIN "Model" fm ON fm.id = fmv."modelId"
    WHERE fr."imageId" = i.id
      AND (fm.poi OR fm.minor)
  )
`;

/**
 * Matched rows: SAMPLE images first (one table, `EXISTS` on an attachment), then join
 * and aggregate only the sample — rather than aggregating the whole window and sorting
 * it. Output is in the sample's random order (`rnd`), so any prefix is itself a random
 * sample. Also the retrieval study's gold: `attachedModels` is model-level
 * `{modelId, modelType}`; `checkpointBaseModels` feeds the request baseModel.
 */
export const GOLDSET_MATCHED_SQL = (days: number, limit: number) => Prisma.sql`
  WITH sampled AS (
    SELECT i.id, i.meta->>'prompt' AS prompt, random() AS rnd
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE ${GOLDSET_ELIGIBLE_IMAGE(days)}
      AND EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = i.id)
    ORDER BY rnd
    LIMIT ${limit}::int
  )
  SELECT s.id AS "imageId",
         s.prompt,
         array_agg(DISTINCT m.type::text) AS "attachedTypes",
         array_agg(DISTINCT mv."baseModel") AS "attachedBaseModels",
         jsonb_agg(DISTINCT jsonb_build_object('modelId', m.id, 'modelType', m.type::text))
           AS "attachedModels",
         COALESCE(
           array_agg(DISTINCT mv."baseModel") FILTER (WHERE m.type = 'Checkpoint'),
           ARRAY[]::text[]
         ) AS "checkpointBaseModels"
  FROM sampled s
  JOIN "ImageResourceNew" irn ON irn."imageId" = s.id
  JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
  JOIN "Model" m ON m.id = mv."modelId"
  GROUP BY s.id, s.prompt, s.rnd
  ORDER BY s.rnd
`;

export const GOLDSET_UNMATCHED_SQL = (days: number, limit: number) => Prisma.sql`
  SELECT i.id AS "imageId",
         i.meta->>'prompt' AS prompt,
         ARRAY[]::text[] AS "attachedTypes",
         ARRAY[]::text[] AS "attachedBaseModels"
  FROM "Image" i
  JOIN "Post" p ON p.id = i."postId"
  WHERE ${GOLDSET_ELIGIBLE_IMAGE(days)}
    AND NOT EXISTS (SELECT 1 FROM "ImageResourceNew" irn WHERE irn."imageId" = i.id)
  ORDER BY random()
  LIMIT ${limit}::int
`;
