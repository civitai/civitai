import { createHash } from 'crypto';
import { parseArgs } from 'util';

import {
  RESOURCE_INTENT_SPEC_HASH,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';
import {
  GOLDSET_MATCHED_SQL,
  GOLDSET_UNMATCHED_SQL,
  PREREGISTERED_RUN_PARAMS,
  preregistrationOverrides,
  renderRetrievalPreregistration,
  type RetrievalRunParams,
} from './eval-resource-intent-registration';
import { drainStdio, runScriptAndExit } from './lib/run-as-script';

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
 * Part two is the pre-registered two-arm RETRIEVAL comparison — the shipped matcher
 * against its popularity seed alone, graded on whether a resource the user
 * actually attached lands in each arm's shortlist head. Its core and its arms live in
 * `./eval-resource-intent-retrieval.ts`, its pre-registration and the gold-set queries in
 * `./eval-resource-intent-registration.ts`; `./eval-resource-intent-goldset-execute.ts`
 * samples the gold and runs it.
 *
 * The retrieval study's positive control is computed from the run itself and can only
 * VOID part two's verdict; part one has no positive control of its own.
 *
 * GATED EXECUTION — the live study needs a prod replica read, the models index + an
 * OpenRouter key (team step). Without `--execute` it prints the committed queries and
 * the retrieval pre-registration, and exits.
 *
 * 🔴 THE DRY RUN IS HERMETIC BY CONSTRUCTION: this file's static imports reach no
 * database or search client (the queries and the pre-registration live in
 * `./eval-resource-intent-registration.ts`), and everything `--execute` needs is in
 * `./eval-resource-intent-goldset-execute.ts`, loaded by a dynamic import only under
 * `--execute`. A static import of either client here would construct a Prisma client
 * the dry run never uses, whose engine-load rejection nothing handles — exit 1 on a
 * host without a Prisma engine, after the dry run has printed. The tsx smoke test spawns
 * the dry run with no engine env and catches that.
 *
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200
 *   pnpm run tsscript scripts/eval-resource-intent-goldset.ts --execute --limit 200 --out /tmp/goldset-report.md
 *
 * Retrieval flags (defaults ARE the pre-registered values; overriding one prints a
 * warning, stamps the report as not the registered run and makes its verdict VOID):
 * `--retrieval-sample` and `--days` (which also sets part one's window). The pilot the
 * doc describes is `--execute --retrieval-sample 100`.
 */

export const GOLDSET_REVIEW_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;
export const GOLDSET_CALIBRATION_BUCKETS = 10;

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

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      limit: { type: 'string' },
      days: { type: 'string' },
      out: { type: 'string' },
      'retrieval-sample': { type: 'string' },
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
      )}). This is NOT the pre-registered run: its verdict is VOID and it does not judge the closing clause.\n`
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

  // Everything past here reads the replica, the index and the vendor. It is loaded only
  // now, so the dry run above never constructs a database or search client.
  const { executeGoldsetStudy } = await import('./eval-resource-intent-goldset-execute');
  await executeGoldsetStudy({
    days,
    matchedLimit,
    unmatchedLimit,
    matchedDraw,
    retrievalParams,
    out: values.out,
  });
}

/** Parse the retrieval flags; every default is the pre-registered value. */
export function parseRetrievalParams(values: {
  'retrieval-sample'?: string;
  days?: string;
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
  };
}

/**
 * Run `main` as a script: DRAIN stdout and stderr, then EXIT — 0 on success, 1 on failure.
 * The exit is explicit because a finished `--execute` otherwise stayed alive on an open
 * handle (it hung for 30+ minutes after writing its report); `closeStudyHandles` closes the
 * known ones, and this makes the end of the run not depend on that list being complete. The
 * drain is what stops that exit truncating a report printed to a pipe; both are the shared
 * rule in ./lib/run-as-script.
 */
export async function runAsScript(
  run: () => Promise<void> = main,
  exit: (code: number) => void = process.exit,
  flush: () => Promise<void> = drainStdio
): Promise<void> {
  await runScriptAndExit(run, exit, flush);
}

if (process.argv[1]?.endsWith('eval-resource-intent-goldset.ts')) {
  void runAsScript();
}
