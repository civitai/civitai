import { createHash } from 'crypto';
import { parseArgs } from 'util';

import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { askJev, JEV_TIMEOUT_MS } from '~/server/services/ai/jev';
import {
  RESOURCE_INTENT_QUESTIONS,
  RESOURCE_INTENT_SPEC_HASH,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentContentType,
  type ResourceIntentRole,
  type ResourceIntentStyleFamily,
} from '~/server/schema/resource-intent.schema';

/**
 * Gold-set study runner (M3) — measures Stage-1 quality against the provenance
 * corpus (past generations), WITHOUT touching any serving path:
 *
 *   matched   — prompts that DID attach resources (`ImageResourceNew` joined to
 *               `Image.meta->>'prompt'`)
 *   unmatched — prompts with NO attached resources (the "none" gold class)
 *
 * Measures: role agreement with actually-attached resource types, needsResource
 * calibration by probability bucket (predicted vs observed attach rate),
 * review-rate curves (what fraction of prompts each role-confidence threshold
 * defers to review), all sliced by role / styleFamily / baseModel. Writes a
 * markdown report.
 *
 * GATED EXECUTION — this script is committed but NOT run in this change:
 * the live study needs a prod replica read + an OpenRouter key (team step).
 * Without `--execute` it prints the committed queries and exits.
 *
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200 --out /tmp/goldset-report.md
 */

export const GOLDSET_REVIEW_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;
export const GOLDSET_CALIBRATION_BUCKETS = 10;
export const DEFAULT_SAMPLE_DAYS = 30;

/** The committed gold-set queries — reviewable and re-runnable as written. */
export const GOLDSET_MATCHED_SQL = (days: number, limit: number) => Prisma.sql`
  SELECT i.id AS "imageId",
         i.meta->>'prompt' AS prompt,
         array_agg(DISTINCT m.type) AS "attachedTypes",
         array_agg(DISTINCT mv.baseModel) AS "attachedBaseModels"
  FROM "ImageResourceNew" irn
  JOIN "Image" i ON i.id = irn."imageId"
  JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
  JOIN "Model" m ON m.id = mv."modelId"
  WHERE i.hideMeta = false
    AND i.meta->>'prompt' IS NOT NULL
    AND length(i.meta->>'prompt') > 0
    AND i."createdAt" > now() - (${days} || ' days')::interval
  GROUP BY i.id
  ORDER BY random()
  LIMIT ${limit}
`;

export const GOLDSET_UNMATCHED_SQL = (days: number, limit: number) => Prisma.sql`
  SELECT i.id AS "imageId",
         i.meta->>'prompt' AS prompt,
         ARRAY[]::text[] AS "attachedTypes",
         ARRAY[]::text[] AS "attachedBaseModels"
  FROM "Image" i
  WHERE i.hideMeta = false
    AND i.meta->>'prompt' IS NOT NULL
    AND length(i.meta->>'prompt') > 0
    AND i."createdAt" > now() - (${days} || ' days')::interval
    AND NOT EXISTS (SELECT 1 FROM "ImageResourceNew" irn WHERE irn."imageId" = i.id)
  ORDER BY random()
  LIMIT ${limit}
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

export function renderGoldsetReport(evaluation: GoldsetEvaluation): string {
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

async function sampleGoldset(days: number, limit: number): Promise<GoldsetRow[]> {
  const matched = await dbRead.$queryRaw<
    { imageId: number; prompt: string; attachedTypes: string[]; attachedBaseModels: string[] }[]
  >(GOLDSET_MATCHED_SQL(days, Math.ceil(limit / 2)));
  const unmatched = await dbRead.$queryRaw<
    { imageId: number; prompt: string; attachedTypes: string[]; attachedBaseModels: string[] }[]
  >(GOLDSET_UNMATCHED_SQL(days, Math.floor(limit / 2)));
  return [...matched, ...unmatched];
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      limit: { type: 'string' },
      days: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });

  const limit = values.limit ? Number.parseInt(values.limit, 10) : 200;
  const days = values.days ? Number.parseInt(values.days, 10) : DEFAULT_SAMPLE_DAYS;

  if (!values.execute) {
    const matched = GOLDSET_MATCHED_SQL(days, Math.ceil(limit / 2));
    const unmatched = GOLDSET_UNMATCHED_SQL(days, Math.floor(limit / 2));
    console.log(
      'Dry run. The gold-set queries (run with --execute against a prod REPLICA):\n\n' +
        `-- matched\n${matched.sql}\n-- values: ${JSON.stringify(matched.values)}\n\n` +
        `-- unmatched\n${unmatched.sql}\n-- values: ${JSON.stringify(unmatched.values)}\n`
    );
    return;
  }

  const rows = await sampleGoldset(days, limit);
  const pairs: { row: GoldsetRow; judgment: GoldsetJudgment }[] = [];
  for (const row of rows) {
    const response = await askJev(
      {
        state: { prompt: row.prompt },
        questions: RESOURCE_INTENT_QUESTIONS.map((q) => ({ ...q })),
      },
      { timeoutMs: JEV_TIMEOUT_MS }
    );
    const byId = new Map(response.answers.map((answer) => [answer.id, answer]));
    const needsResource = byId.get('needsResource');
    const role = byId.get('role');
    const styleFamily = byId.get('styleFamily');
    const contentType = byId.get('contentType');
    const specificity = byId.get('specificity');
    const injectionPresent = byId.get('injectionPresent');
    if (
      needsResource?.type !== 'noul' ||
      role?.type !== 'choice' ||
      styleFamily?.type !== 'choice' ||
      contentType?.type !== 'choice' ||
      specificity?.type !== 'score' ||
      injectionPresent?.type !== 'noul'
    ) {
      console.warn(`[goldset] stage-1 shape mismatch for image ${row.imageId}; row skipped`);
      continue;
    }
    pairs.push({
      row,
      judgment: {
        needsResource: needsResource.value,
        role: { value: role.value as ResourceIntentRole, distribution: role.distribution },
        styleFamily: {
          value: styleFamily.value as ResourceIntentStyleFamily,
          distribution: styleFamily.distribution,
        },
        contentType: {
          value: contentType.value as ResourceIntentContentType,
          distribution: contentType.distribution,
        },
        specificity: specificity.value,
        injectionPresent: injectionPresent.value,
      },
    });
  }

  const evaluation = evaluateGoldset(pairs);
  const report = renderGoldsetReport(evaluation);
  if (values.out) {
    const { writeFile } = await import('fs/promises');
    await writeFile(values.out, report);
    console.log(`[goldset] report written to ${values.out} (${pairs.length} rows judged)`);
  } else {
    console.log(report);
  }
}

if (process.argv[1]?.endsWith('eval-resource-intent-goldset.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
