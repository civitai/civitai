import { Prisma } from '@prisma/client';
import { RESOURCE_INTENT_DEFAULT_LIMIT } from '~/server/schema/resource-intent.schema';

/**
 * M3's registration: the pre-registered constants, the text built from them, and the
 * committed gold-set queries — everything the dry run prints, and nothing else.
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
 * - `planning`: power-planning inputs from an offline replay of v2's prompts. Assumptions,
 *   not evidence; they decide nothing.
 */
export const M3_RETRIEVAL_PREREGISTRATION = {
  version: 3,
  registeredOn: '2026-10-07',
  primaryK: 10,
  secondaryK: RESOURCE_INTENT_DEFAULT_LIMIT,
  alpha: 0.05,
  nonInferiorityMargin: 0.02,
  nonInferiorityZ: 1.645,
  sampleSize: 1000,
  sampleDays: 30,
  cap: RESOURCE_INTENT_DEFAULT_LIMIT,
  minPromotableFraction: 0.1,
  planning: {
    scored: 822,
    replayPrompts: 254,
    replayHitDiscordant: 13,
    mrrNonTieRate: 0.134,
    mrrPurposeShare: 0.68,
  },
  voidIf: { minScored: 667, maxInfraExclusionFraction: 0.1 },
  pilotSampleSize: 100,
} as const;

/** The planned power of each co-primary, derived from `planning` alone. */
export function plannedPower() {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const { scored, replayPrompts, replayHitDiscordant, mrrNonTieRate, mrrPurposeShare } = p.planning;
  const hitDiscordantRate = replayHitDiscordant / replayPrompts;
  // b = c at a true difference of 0, so se = sqrt((b + c) / n) / sqrt(n).
  const hitSe = Math.sqrt(hitDiscordantRate / scored);
  const nonInferiorityPower = 1 - normalCdf(p.nonInferiorityZ - p.nonInferiorityMargin / hitSe);
  const mrrNonTies = Math.round(scored * mrrNonTieRate);
  let mrrPower = 0;
  for (let up = 0; up <= mrrNonTies; up++) {
    const down = mrrNonTies - up;
    if (up > down && exactMcNemarP(up, down) < p.alpha) {
      mrrPower += Math.exp(
        logChoose(mrrNonTies, up) +
          up * Math.log(mrrPurposeShare) +
          down * Math.log(1 - mrrPurposeShare)
      );
    }
  }
  return { hitDiscordantRate, hitSe, nonInferiorityPower, mrrNonTies, mrrPower };
}

/**
 * The running pre-registration as text — printed by the dry run and at the top of every
 * report. Built from the constants so the text cannot state a value the code does not use.
 */
export function renderRetrievalPreregistration(): string {
  const p = M3_RETRIEVAL_PREREGISTRATION;
  const k = p.primaryK;
  const k2 = p.secondaryK;
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
    'seedResourceIntentPool cut to the cap, with no label ordering: the same pool, so the',
    'arms differ only by the re-rank.',
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
    `            ${p.pilotSampleSize}-prompt pilot); fewer than ${p.voidIf.minScored} prompts scored; infrastructure`,
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
    'floor that agrees with the request on role or style family. That is what PURPOSE',
    'reads; without it the re-rank has nothing to act on and the arms cannot differ.',
    '',
    `No identical-head rule: v2 voided a run whose arms returned the same first ${k} model ids`,
    'on every scored prompt. The arms now differ only by the re-rank, which moves nothing',
    'on a prompt whose pool holds no label it promotes or demotes, so identical heads are',
    'expected on most prompts (reciprocal ranks tied on 220 of 254 in the offline replay).',
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
    "Power (planning assumptions from an offline replay of v2's prompts, NOT evidence):",
    `hit@${k} discordance ${p.planning.replayHitDiscordant} of ${p.planning.replayPrompts} = ${pct(
      power.hitDiscordantRate
    )}; at a planning n of ${p.planning.scored} scored,`,
    `se = sqrt(${power.hitDiscordantRate.toFixed(4)} / ${
      p.planning.scored
    }) = ${power.hitSe.toFixed(
      4
    )}, so power for (i) at a true difference of 0 is ${power.nonInferiorityPower.toFixed(2)}.`,
    `MRR@${k2} non-ties ${pct(p.planning.mrrNonTieRate)} of scored (${power.mrrNonTies} of ${
      p.planning.scored
    }) with ${pct(p.planning.mrrPurposeShare)} favouring PURPOSE`,
    `gives power for (ii) of ${power.mrrPower.toFixed(
      2
    )}. The pilot re-measures the scored fraction and`,
    'both rates; a shortfall there means re-planning in a new commit, never after the run.',
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
