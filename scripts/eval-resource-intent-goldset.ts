import { createHash } from 'crypto';
import { parseArgs } from 'util';

import { Prisma } from '@prisma/client';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { dbRead } from '~/server/db/client';
import { askJev, JEV_TIMEOUT_MS } from '~/server/services/ai/jev';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import {
  buildResourceIntentStage1Request,
  compileCriteria,
  parseResourceIntentStage1Answers,
} from '~/server/services/resource-intent.service';
import {
  RESOURCE_INTENT_SPEC_HASH,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';
import {
  countLabeledIndexDocuments,
  evaluateRetrieval,
  loadLabeledModelIds,
  M3_RETRIEVAL_PREREGISTRATION,
  PREREGISTERED_RUN_PARAMS,
  preregistrationOverrides,
  renderRetrievalPreregistration,
  renderRetrievalReport,
  runRetrievalArms,
  type RetrievalGoldRow,
  type RetrievalRunParams,
} from './eval-resource-intent-retrieval';

/**
 * Gold-set study runner (M3) — measures Stage-1 quality against the provenance
 * corpus (past generations), WITHOUT touching any serving path:
 *
 *   matched   — prompts that DID attach resources (`ImageResourceNew` joined to
 *               `Image.meta->>'prompt'`)
 *   unmatched — prompts with NO attached resources (the "none" gold class)
 *
 * Part one measures STAGE 1: role agreement with actually-attached resource
 * types, needsResource calibration by probability bucket (predicted vs observed
 * attach rate), review-rate curves (what fraction of prompts each role-confidence
 * threshold defers to review), sliced by role / styleFamily.
 *
 * Part two is the pre-registered two-arm RETRIEVAL comparison — the purpose-first
 * matcher against the popularity seed alone, graded on whether a resource the user
 * actually attached lands in each arm's shortlist head. Its core, its arms and its
 * pre-registration live in `./eval-resource-intent-retrieval.ts`; this file samples
 * its gold and runs it.
 *
 * The models-index positive control (see the retrieval module) runs before either
 * part, so it gates part one too.
 *
 * GATED EXECUTION — this script is committed but has NEVER been run: the live study
 * needs a prod replica read, the models index + an OpenRouter key (team step).
 * Without `--execute` it prints the committed queries and the retrieval
 * pre-registration, and exits.
 *
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200 --out /tmp/goldset-report.md
 *
 * Retrieval flags (defaults ARE the pre-registered values; overriding one prints a
 * warning and stamps the report as not the registered run): `--retrieval-sample`,
 * `--k`, `--bootstrap-seed`, and `--days`, which also sets the retrieval window.
 */

export const GOLDSET_REVIEW_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;
export const GOLDSET_CALIBRATION_BUCKETS = 10;

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
 * plus public meta, a non-empty prompt, no `blockedFor`, and the window.
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

export type GoldsetRow = {
  imageId: number;
  prompt: string;
  attachedTypes: string[];
  attachedBaseModels: string[];
};

export type GoldsetJudgment = ResourceIntentAnswer;

export type GoldsetRowVerdict = {
  imageId: number;
  promptHash: string;
  hasAttachedResources: boolean;
  judgedRole: ResourceIntentRole;
  /** Does the judged role's type filter cover the attached types? (matched rows only) */
  roleAgrees: boolean | null;
  maxRoleProbability: number;
  maxNonNoneRoleProbability: number;
};

export type GoldsetEvaluation = {
  rows: GoldsetRowVerdict[];
  agreement: {
    matchedTotal: number;
    matchedAgree: number;
    unmatchedTotal: number;
    unmatchedCorrectNone: number;
    unmatchedFalsePositive: number;
  };
  calibration: {
    bucket: number; // floor(p * 10) / 10 — predicted P(attach)
    predicted: number; // mean predicted p in bucket
    observed: number; // observed attach rate in bucket
    n: number;
  }[];
  reviewCurves: {
    threshold: number;
    autoRouteRate: number;
    reviewRate: number;
    agreementWithinAuto: number | null;
  }[];
  slices: {
    byRole: { role: string; n: number; agreement: number | null }[];
    byStyleFamily: { styleFamily: string; n: number; agreement: number | null }[];
  };
};

export function evaluateGoldsetRow(row: GoldsetRow, judgment: GoldsetJudgment): GoldsetRowVerdict {
  const judgedRole = judgment.role.value;
  const maxRoleProbability = Math.max(...Object.values(judgment.role.distribution), 0);
  const maxNonNone = Object.entries(judgment.role.distribution)
    .filter(([option]) => option !== 'none')
    .map(([, p]) => p);
  const maxNonNoneRoleProbability = maxNonNone.length ? Math.max(...maxNonNone) : 0;
  return {
    imageId: row.imageId,
    promptHash: createHash('sha256').update(row.prompt).digest('hex'),
    hasAttachedResources: row.attachedTypes.length > 0,
    judgedRole,
    roleAgrees: judgeRoleAgrees(judgedRole, row.attachedTypes),
    maxRoleProbability,
    maxNonNoneRoleProbability,
  };
}

/**
 * Agreement is TYPE-level: the judged role's ModelType filter must cover at
 * least one attached type. A `none` judgment on a matched row and a non-none
 * judgment on an unmatched row both disagree. Unknowable (no attached types
 * but judged non-none with no way to be right/wrong beyond the class) is
 * still a classifiable boolean here.
 */
export function judgeRoleAgrees(judgedRole: ResourceIntentRole, attachedTypes: string[]): boolean {
  if (judgedRole === 'none') return attachedTypes.length === 0;
  if (attachedTypes.length === 0) return false;
  const allowed = ROLE_MODEL_TYPES[judgedRole] ?? null;
  if (!allowed) return true; // Other/unknown → no type filter, cannot disagree at type level
  return attachedTypes.some((type) => (allowed as readonly string[]).includes(type));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function evaluateGoldset(
  pairs: { row: GoldsetRow; judgment: GoldsetJudgment }[]
): GoldsetEvaluation {
  const verdicts = pairs.map(({ row, judgment }) => evaluateGoldsetRow(row, judgment));

  const matched = verdicts.filter((v) => v.hasAttachedResources);
  const unmatched = verdicts.filter((v) => !v.hasAttachedResources);

  // Calibration: predicted P(attach) = needsResource noul vs OBSERVED attach.
  const calibration: GoldsetEvaluation['calibration'] = [];
  for (let b = 0; b < GOLDSET_CALIBRATION_BUCKETS; b++) {
    const lower = b / GOLDSET_CALIBRATION_BUCKETS;
    const upper = (b + 1) / GOLDSET_CALIBRATION_BUCKETS;
    const inBucket = pairs.filter(
      ({ judgment }) =>
        judgment.needsResource >= lower &&
        (b === GOLDSET_CALIBRATION_BUCKETS - 1
          ? judgment.needsResource <= upper
          : judgment.needsResource < upper)
    );
    if (inBucket.length === 0) continue;
    calibration.push({
      bucket: lower,
      predicted:
        inBucket.reduce((sum, { judgment }) => sum + judgment.needsResource, 0) / inBucket.length,
      observed: inBucket.filter(({ row }) => row.attachedTypes.length > 0).length / inBucket.length,
      n: inBucket.length,
    });
  }

  const reviewCurves = GOLDSET_REVIEW_THRESHOLDS.map((threshold) => {
    const auto = verdicts.filter((v) => v.maxNonNoneRoleProbability >= threshold);
    const review = verdicts.length - auto.length;
    const agreementWithinAuto = auto.length
      ? auto.filter((v) => v.roleAgrees !== false).length / auto.length
      : null;
    return {
      threshold,
      autoRouteRate: auto.length / verdicts.length,
      reviewRate: review / verdicts.length,
      agreementWithinAuto,
    };
  });

  const sliceAgreement = (
    keyOf: (pair: { row: GoldsetRow; judgment: GoldsetJudgment }) => string
  ): { key: string; n: number; agreement: number | null }[] => {
    const groups = new Map<string, boolean[]>();
    pairs.forEach((pair, index) => {
      const verdict = verdicts[index];
      if (verdict.roleAgrees === null) return;
      const key = keyOf(pair);
      groups.set(key, [...(groups.get(key) ?? []), verdict.roleAgrees]);
    });
    return [...groups.entries()].map(([key, values]) => ({
      key,
      n: values.length,
      agreement: mean(values.map((v) => (v ? 1 : 0))),
    }));
  };

  return {
    rows: verdicts,
    agreement: {
      matchedTotal: matched.length,
      matchedAgree: matched.filter((v) => v.roleAgrees).length,
      unmatchedTotal: unmatched.length,
      unmatchedCorrectNone: unmatched.filter((v) => v.judgedRole === 'none').length,
      unmatchedFalsePositive: unmatched.filter((v) => v.judgedRole !== 'none').length,
    },
    calibration,
    reviewCurves,
    slices: {
      byRole: sliceAgreement(({ judgment }) => judgment.role.value).map(({ key, ...rest }) => ({
        role: key,
        ...rest,
      })),
      byStyleFamily: sliceAgreement(({ judgment }) => judgment.styleFamily.value).map(
        ({ key, ...rest }) => ({ styleFamily: key, ...rest })
      ),
    },
  };
}

export function renderGoldsetReport(
  evaluation: GoldsetEvaluation,
  context?: { drawn: number }
): string {
  const { agreement, calibration, reviewCurves, slices } = evaluation;
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const lines: string[] = [
    '# Resource-intent gold-set study (stage 1)',
    '',
    `Spec hash: \`${RESOURCE_INTENT_SPEC_HASH.slice(
      0,
      16
    )}…\` — rows below are only comparable within one hash.`,
    '',
    ...(context
      ? [
          `Judged ${evaluation.rows.length} of ${context.drawn} drawn rows; ${
            context.drawn - evaluation.rows.length
          } skipped on a stage-1 failure.`,
          '',
        ]
      : []),
    '## Agreement',
    '',
    '| slice | n | agreement |',
    '|---|---|---|',
    `| matched prompts, role covers attached types | ${agreement.matchedTotal} | ${pct(
      agreement.matchedTotal ? agreement.matchedAgree / agreement.matchedTotal : null
    )} |`,
    `| unmatched prompts judged none | ${agreement.unmatchedTotal} | ${pct(
      agreement.unmatchedTotal ? agreement.unmatchedCorrectNone / agreement.unmatchedTotal : null
    )} |`,
    `| unmatched prompts judged a role (false positives) | ${agreement.unmatchedTotal} | ${pct(
      agreement.unmatchedTotal ? agreement.unmatchedFalsePositive / agreement.unmatchedTotal : null
    )} |`,
    '',
    '## needsResource calibration (predicted vs observed attach rate)',
    '',
    '| bucket (P) | predicted | observed | n |',
    '|---|---|---|---|',
    ...calibration.map(
      (c) =>
        `| ${c.bucket.toFixed(1)}–${(c.bucket + 0.1).toFixed(1)} | ${c.predicted.toFixed(
          3
        )} | ${c.observed.toFixed(3)} | ${c.n} |`
    ),
    '',
    '## Review-rate curves (defer when max non-none role probability < threshold)',
    '',
    '| threshold | auto-route | review | agreement within auto |',
    '|---|---|---|---|',
    ...reviewCurves.map(
      (c) =>
        `| ${c.threshold} | ${pct(c.autoRouteRate)} | ${pct(c.reviewRate)} | ${pct(
          c.agreementWithinAuto
        )} |`
    ),
    '',
    '## Slices',
    '',
    '### By judged role',
    '',
    '| role | n | type-level agreement |',
    '|---|---|---|',
    ...slices.byRole.map((s) => `| ${s.role} | ${s.n} | ${pct(s.agreement)} |`),
    '',
    '### By judged style family',
    '',
    '| styleFamily | n | type-level agreement |',
    '|---|---|---|',
    ...slices.byStyleFamily.map((s) => `| ${s.styleFamily} | ${s.n} | ${pct(s.agreement)} |`),
    '',
  ];
  return lines.join('\n');
}

type MatchedSqlRow = GoldsetRow & {
  attachedModels: { modelId: number; modelType: string }[];
  checkpointBaseModels: string[];
};

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      limit: { type: 'string' },
      days: { type: 'string' },
      out: { type: 'string' },
      'retrieval-sample': { type: 'string' },
      k: { type: 'string' },
      'bootstrap-seed': { type: 'string' },
    },
    strict: true,
  });

  const limit = values.limit ? Number.parseInt(values.limit, 10) : 200;
  const retrievalParams = parseRetrievalParams(values);
  // One window for both parts: `--days` sets it, and overriding it is an override of
  // the retrieval pre-registration.
  const days = retrievalParams.sampleDays;
  const matchedLimit = Math.ceil(limit / 2);
  const unmatchedLimit = Math.floor(limit / 2);
  // ONE matched draw serves both parts: its rows come back in random order, so part
  // one takes a prefix and part two takes the first `sampleSize`.
  const matchedDraw = Math.max(matchedLimit, retrievalParams.sampleSize);
  const overrides = preregistrationOverrides(retrievalParams);
  if (overrides.length) {
    console.warn(
      `\n🔴🔴🔴 WARNING: retrieval parameters OVERRIDE the pre-registration (${overrides.join(
        '; '
      )}). This is NOT the pre-registered run, and its decision is not the registered decision.\n`
    );
  }

  if (!values.execute) {
    const matched = GOLDSET_MATCHED_SQL(days, matchedDraw);
    const unmatched = GOLDSET_UNMATCHED_SQL(days, unmatchedLimit);
    console.log(
      'Dry run. The gold-set queries (run with --execute against a prod REPLICA):\n\n' +
        `-- matched (part one takes the first ${matchedLimit}, the retrieval study the first ${
          retrievalParams.sampleSize
        })\n${matched.sql}\n-- values: ${JSON.stringify(matched.values)}\n\n` +
        `-- unmatched (part one)\n${unmatched.sql}\n-- values: ${JSON.stringify(
          unmatched.values
        )}\n\n` +
        `${renderRetrievalPreregistration()}\n`
    );
    return;
  }

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
  if (values.out) {
    const { writeFile } = await import('fs/promises');
    await writeFile(values.out, report);
    console.log(
      `[goldset] report written to ${values.out} (${pairs.length} of ${partOneRows.length} stage-1 rows judged, ${retrieval.primary.n} retrieval prompts scored)`
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

/** Parse the retrieval flags; every default is the pre-registered value. */
export function parseRetrievalParams(values: {
  'retrieval-sample'?: string;
  days?: string;
  k?: string;
  'bootstrap-seed'?: string;
}): RetrievalRunParams {
  const int = (raw: string | undefined, fallback: number, name: string) => {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return parsed;
  };
  return {
    sampleSize: int(
      values['retrieval-sample'],
      PREREGISTERED_RUN_PARAMS.sampleSize,
      'retrieval-sample'
    ),
    sampleDays: int(values.days, PREREGISTERED_RUN_PARAMS.sampleDays, 'days'),
    primaryK: int(values.k, PREREGISTERED_RUN_PARAMS.primaryK, 'k'),
    bootstrapSeed: int(
      values['bootstrap-seed'],
      PREREGISTERED_RUN_PARAMS.bootstrapSeed,
      'bootstrap-seed'
    ),
  };
}

if (process.argv[1]?.endsWith('eval-resource-intent-goldset.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
