import { pgDbRead } from '~/server/db/pgDb';

/**
 * Reaction-pipeline reconciliation.
 *
 * Everything else that watches this pipeline compares two points *inside* it
 * (`entityMetricEvents_month` vs `entityMetricDailyAgg_v2`, Redis vs CH), so a
 * loss at the CDC boundary is invisible to all of them. These two checks are the
 * only ones that read Postgres — the actual source of truth — on one arm.
 *
 * Direction matters: we assert PG -> CH, never a count ratio. An un-reaction
 * deletes the PG row but leaves its `+1` in ClickHouse forever, so raw counts
 * disagree by a few percent that *grows with the age of the window*; a surviving
 * PG row with no matching CH `+1` has no benign explanation.
 */

export const REACTION_METRICS = ['Like', 'Heart', 'Laugh', 'Cry'] as const;
export type ReactionMetric = (typeof REACTION_METRICS)[number];

/**
 * The reaction rename landed in Nov 2025 (2025-10: 34.0M legacy / 3 short;
 * 2025-12: 0 legacy / 20.9M short), and `entityMetricEvents_month` still holds
 * both spellings. `entityMetricUserState_v3` is canonical-only, so only the event
 * table needs the legacy names — reading it with short names alone would see 14 of
 * 54,272 rows on a pre-rename hour and report ~0.0003 coverage, which is
 * indistinguishable from total CDC loss on an hour where nothing was lost.
 */
const LEGACY_REACTION_METRICS = [
  'ReactionLike',
  'ReactionHeart',
  'ReactionLaugh',
  'ReactionCry',
] as const;

/**
 * `clickhouse.$query` interpolates rather than binds, and its array branch joins
 * with `,` and no quoting — a string array would render as bare identifiers.
 * Numeric arrays are fine inline; string lists have to arrive pre-quoted.
 */
const quoteList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');
/** `entityMetricUserState_v3` — canonical names only. */
const REACTION_METRIC_LIST = quoteList(REACTION_METRICS);
/** `entityMetricEvents_month` — spans the rename, so both spellings. */
const EVENT_METRIC_LIST = quoteList([...REACTION_METRICS, ...LEGACY_REACTION_METRICS]);

/** Folds legacy spellings onto canonical ones. Mirrors `entityMetricDirty_v3_mv`. */
const CANONICAL_METRIC_SQL = `multiIf(
  metricType = 'ReactionLike', 'Like',
  metricType = 'ReactionHeart', 'Heart',
  metricType = 'ReactionLaugh', 'Laugh',
  metricType = 'ReactionCry', 'Cry',
  metricType)`;

const CH_MEMORY_LIMIT = 4_000_000_000;

/**
 * Debezium stamps CH `createdAt` from the Postgres *commit* time while PG stamps
 * its own `createdAt` at statement time, so a row can land one bucket over.
 * Widening only the CH side is safe: it can add false matches for rows outside
 * the window, never hide a real drop.
 */
const BOUNDARY_MARGIN_MINUTES = 5;

/**
 * `ImageReaction` has no index on `createdAt` (see `pg_indexes`), so a bare
 * `WHERE "createdAt" >= …` is a parallel seq scan over 245M rows — 6.4M buffers
 * and ~15s per call. `id` is a monotonic serial, so we binary-search the pkey
 * for the id bounds and range-scan those instead (~250ms). The pad absorbs the
 * id/createdAt skew from concurrent inserts; `createdAt` is still filtered
 * exactly, so the pad only ever costs a few extra heap rows.
 */
const ID_PAD = 50_000;

export type HourlyCoverageResult = {
  hourStart: Date;
  pgRows: number;
  matched: number;
  missing: number;
  /** null when the hour had no PG rows at all — an undefined ratio, not a failure. */
  coverage: number | null;
  /** PG reaction values with no CH metricType mapping. Non-zero means a mapping gap. */
  unknownReactions: Record<string, number>;
  affectedImageIds: number[];
  durationMs: number;
};

export type ExactnessResult = {
  imagesSampled: number;
  /** Sampled images whose PG row is gone (deleted image). Excluded from the rates. */
  imagesDeleted: number;
  pairsChecked: number;
  pairsExact: number;
  /** In PG, absent from CH. Real data loss. */
  missingInCh: number;
  /** In CH, absent from PG. Mostly the known un-reaction residual (~0.37%). */
  phantomInCh: number;
  coverage: number | null;
  /** Coverage restricted to reactions created inside the lookback. The health signal. */
  recentCoverage: number | null;
  /** Coverage over everything older — a burn-down of un-repaired history, not live health. */
  backlogCoverage: number | null;
  recentPairs: number;
  backlogPairs: number;
  phantomRate: number | null;
  affectedImageIds: number[];
  durationMs: number;
};

const EMPTY_EXACTNESS = {
  pairsChecked: 0,
  pairsExact: 0,
  missingInCh: 0,
  phantomInCh: 0,
  coverage: null,
  recentCoverage: null,
  backlogCoverage: null,
  recentPairs: 0,
  backlogPairs: 0,
  phantomRate: null,
  affectedImageIds: [],
} satisfies Partial<ExactnessResult>;

/**
 * Handed the images a check found wrong, so a detection can trigger a fix
 * instead of only an alert. Implementations compute the per-user diff against
 * Postgres and insert compensating +1/-1 rows into `entityMetricEvents_month`.
 *
 * Deliberately not implemented here: repair writes to ClickHouse, and wiring
 * that to an automatic trigger before the detector has a track record risks
 * amplifying a detector bug into data corruption. Register a hook when ready.
 */
export type ReactionRepairRequest = {
  imageIds: number[];
  reason: 'hourly-coverage' | 'nightly-exactness';
  detectedAt: Date;
  windowStart?: Date;
  windowEnd?: Date;
};
export type ReactionRepairHook = (request: ReactionRepairRequest) => Promise<void>;

let repairHook: ReactionRepairHook | undefined;
export function setReactionRepairHook(hook: ReactionRepairHook | undefined) {
  repairHook = hook;
}
export async function requestReactionRepair(request: ReactionRepairRequest) {
  if (!repairHook || request.imageIds.length === 0) return false;
  await repairHook(request);
  return true;
}

const key = (imageId: number, userId: number, reaction: string) =>
  `${imageId}|${userId}|${reaction}`;

/**
 * `ImageReaction.createdAt` is `timestamp without time zone` holding UTC, and both
 * directions of the pg driver's conversion for that type go through the *process*
 * timezone: a JS `Date` parameter is serialized with the local offset (which PG then
 * discards), and a returned value is parsed as local. On any pod not running UTC
 * both silently shift the audit window by the offset. Passing UTC ISO strings and
 * casting to `timestamp` — and never comparing a returned timestamp in JS — makes
 * the whole path independent of where it runs.
 */
const toPgTimestamp = (date: Date) => date.toISOString();

/**
 * Smallest id at which the table has reached `ts`. Each probe is a pkey index scan.
 *
 * The probe deliberately looks *backwards* (`id <= mid ORDER BY id DESC`). Probing
 * forwards returns the smallest existing id >= mid, which for sparse ids can be
 * >= `hi` — and `hi = thatId` then moves nothing, `lo` moves nothing, `mid`
 * recomputes identically, and the loop spins forever issuing the same query.
 * `ImageReaction` ids are sparse because un-reactions delete rows, so that is the
 * ordinary case, not an edge: the forwards form stalled on 2 of 10 consecutive
 * recent hours. Looking backwards keeps `mid < hi` invariant, so every branch
 * strictly moves a bound and termination is structural.
 */
async function findIdAtOrAfter(ts: string, lo: number, hi: number, checkCanceled?: () => void) {
  // Structural termination is the guarantee; this only converts a future
  // regression into a loud failure instead of a silent spin.
  const maxIterations = Math.ceil(Math.log2(Math.max(2, hi - lo))) + 2;
  let iterations = 0;
  while (lo < hi) {
    checkCanceled?.();
    if (++iterations > maxIterations) {
      throw new Error(
        `findIdAtOrAfter exceeded ${maxIterations} iterations (lo=${lo} hi=${hi} ts=${ts}) — binary search is not converging`
      );
    }
    const mid = Math.floor((lo + hi) / 2);
    const { rows } = await pgDbRead.query<{ reached: boolean }>(
      `SELECT ("createdAt" >= $2::timestamp) AS reached
         FROM "ImageReaction" WHERE id <= $1 ORDER BY id DESC LIMIT 1`,
      [mid, ts]
    );
    if (rows.length && rows[0].reached) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function readPgReactionsForHour(hourStart: Date, checkCanceled?: () => void) {
  const start = toPgTimestamp(hourStart);
  const end = toPgTimestamp(new Date(hourStart.getTime() + 3_600_000));
  const { rows: maxRows } = await pgDbRead.query<{ max: string | null }>(
    'SELECT max(id) AS max FROM "ImageReaction"'
  );
  const maxId = Number(maxRows[0]?.max ?? 0);
  if (!maxId) return [];

  const loId = Math.max(1, (await findIdAtOrAfter(start, 1, maxId, checkCanceled)) - ID_PAD);
  const hiId = Math.min(maxId, (await findIdAtOrAfter(end, loId, maxId, checkCanceled)) + ID_PAD);

  const { rows } = await pgDbRead.query<{ imageId: number; userId: number; reaction: string }>(
    `SELECT "imageId", "userId", reaction::text AS reaction
       FROM "ImageReaction"
      WHERE id BETWEEN $1 AND $2
        AND "createdAt" >= $3::timestamp AND "createdAt" < $4::timestamp`,
    [loId, hiId, start, end]
  );
  return rows;
}

/**
 * Fraction of Postgres reaction rows created in `hourStart` that reached
 * ClickHouse. Healthy is exactly 1.0 — see the job for the measured
 * distribution and the threshold derived from it.
 */
export async function auditReactionHour(
  hourStart: Date,
  { checkCanceled }: { checkCanceled?: () => void } = {}
): Promise<HourlyCoverageResult> {
  const startedAt = Date.now();
  const { clickhouse } = await import('~/server/clickhouse/client');
  if (!clickhouse) throw new Error('clickhouse client unavailable');

  const pgRows = await readPgReactionsForHour(hourStart, checkCanceled);

  const chRows = await clickhouse.$query<{ entityId: number; userId: number; metricType: string }>`
    SELECT entityId, userId, ${CANONICAL_METRIC_SQL} AS metricType
      FROM entityMetricEvents_month
     WHERE entityType = 'Image'
       AND metricType IN (${EVENT_METRIC_LIST})
       AND metricValue > 0
       AND createdAt >= ${hourStart} - INTERVAL ${BOUNDARY_MARGIN_MINUTES} MINUTE
       AND createdAt <  ${hourStart} + INTERVAL 1 HOUR + INTERVAL ${BOUNDARY_MARGIN_MINUTES} MINUTE
     GROUP BY entityId, userId, metricType
    SETTINGS max_memory_usage = ${CH_MEMORY_LIMIT}
  `;

  const chSet = new Set(chRows.map((r) => key(r.entityId, r.userId, r.metricType)));
  const known = new Set<string>(REACTION_METRICS);

  const unknownReactions: Record<string, number> = {};
  const affected = new Set<number>();
  let matched = 0;
  let unknown = 0;

  for (const row of pgRows) {
    if (!known.has(row.reaction)) {
      unknownReactions[row.reaction] = (unknownReactions[row.reaction] ?? 0) + 1;
      unknown++;
      continue;
    }
    if (chSet.has(key(row.imageId, row.userId, row.reaction))) matched++;
    else affected.add(row.imageId);
  }

  const comparable = pgRows.length - unknown;
  return {
    hourStart,
    pgRows: pgRows.length,
    matched,
    missing: comparable - matched,
    coverage: comparable > 0 ? matched / comparable : null,
    unknownReactions,
    affectedImageIds: [...affected],
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Per-`(imageId, userId, reaction)` reconciliation for a sample of recently
 * touched images. Catches what a volume check structurally cannot: phantom rows,
 * a wrong metricType mapping, and dedupe regressions.
 *
 * Reaction totals are distinct users with `argMaxMerge(latest) > 0`, not a sum of
 * events, so this compares membership of the live per-user set — reducing CH
 * events to a count here would give the wrong answer.
 */
export async function auditReactionExactness({
  sampleSize = 200,
  lookbackHours = 24,
  seed = 0,
}: { sampleSize?: number; lookbackHours?: number; seed?: number } = {}): Promise<ExactnessResult> {
  const startedAt = Date.now();
  const { clickhouse } = await import('~/server/clickhouse/client');
  if (!clickhouse) throw new Error('clickhouse client unavailable');

  /**
   * `ORDER BY cityHash64(entityId)` is a stable ordering, not a random draw — the
   * same seed over the same candidate set returns the same images. `seed` is what
   * makes a run reproducible (and what lets a caller sweep several samples); the
   * nightly job varies it by day so successive nights cover different images.
   */
  const sampled = await clickhouse.$query<{ entityId: number }>`
    SELECT entityId
      FROM entityMetricEvents_month
     WHERE entityType = 'Image'
       AND metricType IN (${EVENT_METRIC_LIST})
       AND createdAt > now() - INTERVAL ${lookbackHours} HOUR
     GROUP BY entityId
     ORDER BY cityHash64(entityId + ${seed})
     LIMIT ${sampleSize}
    SETTINGS max_memory_usage = ${CH_MEMORY_LIMIT}
  `;
  const imageIds = sampled.map((r) => Number(r.entityId)).filter(Number.isFinite);
  if (!imageIds.length) {
    return {
      ...EMPTY_EXACTNESS,
      imagesSampled: 0,
      imagesDeleted: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Reactions on deleted images live in ClickHouse forever while Postgres
   * cascades them away, so an image that no longer exists reports its entire
   * reaction set as phantom. Restricting to live images is what keeps this
   * check from being pure noise.
   */
  const { rows: liveRows } = await pgDbRead.query<{ id: number }>(
    'SELECT id FROM "Image" WHERE id = ANY($1::int[])',
    [imageIds]
  );
  const liveIds = liveRows.map((r) => r.id);
  const imagesDeleted = imageIds.length - liveIds.length;
  if (!liveIds.length) {
    return {
      ...EMPTY_EXACTNESS,
      imagesSampled: imageIds.length,
      imagesDeleted,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * `recent` splits the result into a live-health arm and a backlog arm. Sampling
   * by image pulls in each image's ENTIRE reaction history, so an image touched
   * today drags along reactions from the 2025-12..2026-06 outage that were never
   * repaired. Measured 2026-08-07, the two arms differ by a factor of ~10 (see the
   * job header) — collapsing them into one number produces a metric that tracks
   * repair-job progress rather than pipeline health.
   */
  const { rows: pgPairs } = await pgDbRead.query<{
    imageId: number;
    userId: number;
    reaction: string;
    recent: boolean;
  }>(
    `SELECT "imageId", "userId", reaction::text AS reaction,
            ("createdAt" > (now() AT TIME ZONE 'utc') - ($2 || ' hours')::interval) AS recent
       FROM "ImageReaction" WHERE "imageId" = ANY($1::int[])`,
    [liveIds, lookbackHours]
  );

  /**
   * `argMaxMerge(latest) > 0` over the user-state view is the same predicate the
   * site's totals use, so this reconciles what users actually see rather than
   * the raw event log.
   */
  const chPairs = await clickhouse.$query<{
    entityId: number;
    userId: number;
    metricType: string;
  }>`
    SELECT entityId, userId, metricType
      FROM entityMetricUserState_v3
     WHERE entityType = 'Image'
       AND entityId IN (${liveIds})
       AND metricType IN (${REACTION_METRIC_LIST})
     GROUP BY entityId, userId, metricType
    HAVING argMaxMerge(latest) > 0
    SETTINGS max_memory_usage = ${CH_MEMORY_LIMIT}
  `;

  const pgSet = new Set(pgPairs.map((r) => key(r.imageId, r.userId, r.reaction)));
  const chSet = new Set(chPairs.map((r) => key(r.entityId, r.userId, r.metricType)));

  const affected = new Set<number>();
  let missingInCh = 0;
  let recentPairs = 0;
  let recentMissing = 0;
  let backlogPairs = 0;
  let backlogMissing = 0;
  for (const r of pgPairs) {
    const missed = !chSet.has(key(r.imageId, r.userId, r.reaction));
    if (r.recent) {
      recentPairs++;
      if (missed) recentMissing++;
    } else {
      backlogPairs++;
      if (missed) backlogMissing++;
    }
    if (missed) {
      missingInCh++;
      affected.add(r.imageId);
    }
  }
  let phantomInCh = 0;
  for (const r of chPairs) {
    if (!pgSet.has(key(r.entityId, r.userId, r.metricType))) {
      phantomInCh++;
      affected.add(Number(r.entityId));
    }
  }

  const union = new Set([...pgSet, ...chSet]);
  return {
    imagesSampled: imageIds.length,
    imagesDeleted,
    pairsChecked: union.size,
    pairsExact: union.size - missingInCh - phantomInCh,
    missingInCh,
    phantomInCh,
    coverage: pgSet.size > 0 ? (pgSet.size - missingInCh) / pgSet.size : null,
    recentCoverage: recentPairs > 0 ? (recentPairs - recentMissing) / recentPairs : null,
    backlogCoverage: backlogPairs > 0 ? (backlogPairs - backlogMissing) / backlogPairs : null,
    recentPairs,
    backlogPairs,
    phantomRate: chSet.size > 0 ? phantomInCh / chSet.size : null,
    affectedImageIds: [...affected],
    durationMs: Date.now() - startedAt,
  };
}
