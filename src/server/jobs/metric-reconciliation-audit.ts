import client from 'prom-client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { PROM_PREFIX } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { repairReactionMetrics } from '~/server/services/metric-reaction-repair.service';
import {
  auditReactionExactness,
  auditReactionHour,
  requestReactionRepair,
  setReactionRepairHook,
} from '~/server/services/metric-reconciliation.service';
import { createJob } from './job';

/**
 * Reaction-pipeline reconciliation jobs. These are the only checks that read
 * Postgres on one arm; everything else compares two points inside the same
 * lineage and so cannot see a loss at the CDC boundary. Between 2025-12-01 and
 * 2026-06-23 the consumer silently dropped ~21.6M reaction events and every
 * existing health check stayed green.
 *
 * They live in the main app rather than in the watcher on purpose: an auditor
 * that shares a failure domain with the thing it audits goes quiet exactly when
 * it matters. A watcher outage stops the pipeline *and* would stop an in-watcher
 * audit; this one keeps reporting.
 *
 * ── Thresholds, and the data behind them ──────────────────────────────────
 * Coverage is `matched / comparable`, PG -> CH. Measured 2026-08-07 against
 * production, one call per hour:
 *
 *   post-fix: 27 hours across 2026-08-05/06/07, 662,531 Postgres rows
 *     coverage = 1.000000 on every hour. Zero misses. No residual, no variance.
 *   inside the outage window, measured BEFORE the historical repair ran
 *     2026-02-11 14:00  coverage 0.019165  (23,849 of 24,315 rows lost)
 *     2026-05-14 03:00  coverage 0.712498  ( 6,478 of 22,532 rows lost)
 *   those two have since been backfilled and no longer reproduce; an hour that
 *   had not been repaired at time of writing:
 *     2026-03-10 14:00  coverage 0.988355  (   264 of 22,670 rows lost)
 *
 * So the healthy distribution is a point mass at 1.0 and the failure signal is
 * 0.02–0.71. WARN at 0.999 sits ~1000x outside the observed noise while still
 * catching a loss of 1-in-1000; CRIT at 0.99 is a two-order-of-magnitude event.
 *
 * The naive count-ratio version of this check does NOT have that property, and
 * the ~0.98 it suggests is inside its own noise. Un-reactions delete the PG row
 * but leave the `+1` in ClickHouse, so raw `count(*)` ratios ran 0.965–0.998
 * across those same healthy hours — half of them would have tripped a 0.98
 * threshold, and the ratio drifts further from 1 the longer you wait to audit.
 * Matching per `(imageId, userId, reaction)` removes that asymmetry entirely.
 *
 * The nightly exactness check needs its own split. Sampling by image pulls each
 * image's ENTIRE reaction history, so its headline coverage is dominated by
 * un-repaired outage residue rather than by current health. 200 images per sample,
 * `seed` 0..6, 2026-08-07 — the sample is a stable hash ordering rather than a
 * random draw, so passing the same seed reproduces the same images and figures:
 *
 *   headline coverage   0.9559 – 0.9929   (mean ~0.978)
 *   reactions <24h old  1.0000, 1.0000, 0.9974
 *   reactions older     0.9530, 0.9734, 0.9803
 *   phantom rate        0.0016 – 0.0066   (mean ~0.0037)
 *
 * So `recentCoverage` is the health signal and shares the hourly thresholds;
 * `backlogCoverage` is a burn-down of the outage and must NOT be alerted on until
 * the repair job finishes — it would fire every night and get muted in a week.
 * The phantom rate independently reproduces the known ~0.37% un-reaction residual,
 * which is the evidence that 1% is the right ceiling for it.
 */

const COVERAGE_WARN = 0.999;
const COVERAGE_CRIT = 0.99;

/**
 * Audit H-2, not H-1. Batching plus flush latency means the tail of H-1 may still
 * be in flight; H-2 is settled. The `SETTINGS`-pinned CH read is ~700ms and the
 * id-bounded PG read ~250ms, so the whole check is a few seconds.
 */
const AUDIT_LAG_HOURS = 2;

// HMR re-evaluates this module, and prom-client throws on duplicate registration.
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var metricReconciliationGauges: Record<GaugeName, client.Gauge<string>> | undefined;
}

type GaugeName = keyof typeof GAUGE_HELP;

const GAUGE_HELP = {
  hourly_coverage_ratio:
    'Fraction of Postgres ImageReaction rows for the audited hour present in entityMetricEvents_month (1.0 = no loss)',
  hourly_missing_rows:
    'Postgres ImageReaction rows for the audited hour with no matching ClickHouse event',
  hourly_unmapped_rows:
    'Postgres reaction values with no ClickHouse metricType mapping (non-zero = mapping gap)',
  audit_last_run_timestamp_seconds:
    'Unix time of the last completed hourly reaction reconciliation run',
  exactness_last_run_timestamp_seconds:
    'Unix time the nightly exactness audit last completed. Re-published hourly, but always carries the nightly run time, never the re-publish time',
  exactness_recent_coverage_ratio:
    'Per-(image,user,reaction) pairs from the last 24h present in both Postgres and entityMetricUserState_v3',
  exactness_backlog_coverage_ratio:
    'Same, for reactions older than the lookback. Un-repaired outage burn-down — do not alert on this',
  exactness_phantom_ratio:
    'Per-(image,user,reaction) pairs in ClickHouse with no Postgres row (known residual ~0.0037)',
  exactness_recent_pairs:
    'Reaction pairs inside the nightly lookback. Zero means the recent-coverage ratio is undefined rather than 0.0 — gate alerts on it',
} as const;

/**
 * A job runs on one pod, but every pod registers these gauges and prom-client never
 * resets them — so aggregate with
 * `max(<gauge> and on(pod) topk(1, ..._last_run_timestamp_seconds != 0))`, never
 * `min()`, `avg()`, or a bare `max()`. Measured 2026-08-10: 189 series for
 * `hourly_coverage_ratio`, exactly 2 non-zero. `min`/`avg` read the ~187 pods that
 * never ran; a bare `max` reads whichever pod remembers the best value, and one of
 * those two live series was 2h stale, so a bad hour would have read green.
 *
 * The `!= 0` must sit INSIDE `topk` — `topk(1, gauge)` still returns a pod when
 * every value is zero, because the zeros tie and one wins arbitrarily.
 *
 * The last-run gauges are what catch a job silently stopping, which is otherwise
 * indistinguishable from a healthy pipeline. They need an `absent()` alert as well
 * as a staleness one: once every pod holding a value has been replaced the `!= 0`
 * selector is empty, so a staleness rule evaluates to NoData and stays quiet in
 * exactly the state it exists to catch.
 */
const gauges = (global.metricReconciliationGauges ??= Object.fromEntries(
  Object.entries(GAUGE_HELP).map(([name, help]) => [
    name,
    new client.Gauge({ name: `${PROM_PREFIX}reaction_${name}`, help }),
  ])
) as Record<GaugeName, client.Gauge<string>>);

/**
 * Registering the hook does not arm writes — the `metric-reaction-repair` Flipt
 * flag gates them, and reads false until someone turns it on.
 *
 * While it is off, the nightly path still runs the diff as a dry run so there is
 * some production evidence of what enabling it would write. Without that, turning
 * the flag on goes from zero observation straight to live inserts. Nightly is
 * capped at 200 images, so the read cost is negligible. The hourly path stays
 * fully gated: it fires on exactly the outage where extra read load is worst, and
 * one measured outage hour flagged ~17k images.
 *
 * Once the flag is on, both paths repair for real.
 */
setReactionRepairHook(async ({ imageIds, reason }) => {
  const repairEnabled = await isFlipt(FLIPT_FEATURE_FLAGS.METRIC_REACTION_REPAIR);
  const previewOnly = reason === 'nightly-exactness' && !repairEnabled;
  const result = await repairReactionMetrics(imageIds, { dryRun: previewOnly });
  await logToAxiom({
    type: 'metric-reconciliation',
    name: 'reaction-repair',
    // Alerting lives on the gauges, not here. The one condition needing a human is
    // work this run dropped and nothing will pick up.
    level: result.imagesSkippedOverCap > 0 ? 'warn' : 'info',
    message: `repair ${reason}: +${result.additions} -${result.removals} inserted=${
      result.inserted
    }${result.skippedReason ? ` (${result.skippedReason})` : ''}`,
    error: JSON.stringify(result),
  }).catch(() => undefined);
});

type NightlyExactnessSnapshot = {
  /** The nightly's own completion time. Never the re-publish time — see below. */
  ranAt: number;
  recentCoverage: number | null;
  backlogCoverage: number | null;
  phantomRate: number | null;
  /**
   * Published unconditionally, including as 0, because it is the only thing that makes
   * a null arm observable. An unset gauge and a genuine 0.0 are byte-identical on the
   * scrape, so `recentCoverage === null` (no recent pairs in the sample) is otherwise
   * indistinguishable from a measured total loss — and alerting on the second while
   * silently paging on the first is exactly the confusion this pair of gauges exists to
   * resolve. Alert queries gate the coverage ratio on this being non-zero.
   *
   * A zero here is NOT a quiet site. It requires 200 sampled images that all have recent
   * ClickHouse reaction events and no recent Postgres rows, which is mass PG-side loss or
   * mass phantom events. Measured over five consecutive daily seeds, 195-198 of 200
   * images had recent Postgres reactions, so the healthy value is in the hundreds.
   */
  recentPairs: number;
};

/**
 * The nightly writes its gauges once a day; the jobs deployment rolls several times
 * a day. Measured 2026-08-10, ~10h after a successful 04:43 run: all 189
 * `exactness_recent_coverage_ratio` series read 0 — the value was simply gone, and a
 * panel or alert built on it could not tell a healthy nightly from a dead one.
 *
 * So the nightly persists its result and the hourly job re-publishes it, which also
 * puts the nightly's values on the same pod that carries
 * `audit_last_run_timestamp_seconds` — the freshness anchor the hourly queries
 * already join against.
 *
 * `ranAt` is the nightly's completion time and is re-published verbatim. Stamping it
 * at re-publish would make a dead nightly look alive forever, which is the exact
 * failure this exists to expose.
 *
 * Deliberately NO TTL. An earlier version expired the key after 7 days on tidiness
 * grounds, which quietly converted a firing alert into a false recovery: on expiry the
 * re-publish stops, the next roll empties the gauges, the staleness rule's selector goes
 * empty, NoData resolves to OK, and an alert about a dead nightly RESOLVES while the
 * nightly is still dead. A stale snapshot is not a leak — it is the evidence, and
 * `ranAt` is what makes its staleness legible. One key.
 */

/**
 * A null arm leaves its gauge unset, which reads as 0 on the scrape — identical to a
 * measured 0.0. `recentPairs` is what tells the two apart, so it is always published
 * and alert queries gate on it. Do NOT resolve this by publishing a null as 0: that
 * makes the healthy-but-empty case page, and makes a real total loss unremarkable.
 */
function publishNightlyExactnessGauges(snapshot: NightlyExactnessSnapshot) {
  if (snapshot.recentCoverage !== null)
    gauges.exactness_recent_coverage_ratio.set(snapshot.recentCoverage);
  if (snapshot.backlogCoverage !== null)
    gauges.exactness_backlog_coverage_ratio.set(snapshot.backlogCoverage);
  if (snapshot.phantomRate !== null) gauges.exactness_phantom_ratio.set(snapshot.phantomRate);
  gauges.exactness_recent_pairs.set(snapshot.recentPairs);
  gauges.exactness_last_run_timestamp_seconds.set(snapshot.ranAt);
}

/**
 * Validated rather than cast. `JSON.parse(raw) as T` is a lie the compiler cannot check,
 * and the specific way it bites here is silent: `undefined !== null` is true, so a field
 * missing after a deploy that changes the snapshot shape reaches `gauge.set(undefined)`,
 * which throws — and the caller's catch then swallows it, publishing NO gauges at all
 * while the hourly audit reports success.
 */
function parseSnapshot(raw: string): NightlyExactnessSnapshot | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const s = parsed as Record<string, unknown>;
  const nullableNumber = (v: unknown) => v === null || typeof v === 'number';
  if (typeof s.ranAt !== 'number' || typeof s.recentPairs !== 'number') return undefined;
  if (!nullableNumber(s.recentCoverage)) return undefined;
  if (!nullableNumber(s.backlogCoverage)) return undefined;
  if (!nullableNumber(s.phantomRate)) return undefined;
  return s as NightlyExactnessSnapshot;
}

/**
 * Failures are logged, not swallowed. Every other failure path in this file reports to
 * Axiom, and a silent one here is worse than most: a stale or unreadable snapshot
 * re-publishes yesterday's coverage over today's and rewinds the nightly's freshness
 * stamp, so the gauges look present and current while being neither.
 */
async function republishNightlyExactnessGauges() {
  let raw: string | null;
  try {
    raw = await sysRedis.get(REDIS_SYS_KEYS.METRIC_RECONCILIATION.NIGHTLY_EXACTNESS);
  } catch (e) {
    await logToAxiom({
      type: 'metric-reconciliation',
      name: 'reaction-exactness-republish',
      level: 'warn',
      message: 'could not read the nightly exactness snapshot',
      error: JSON.stringify({ error: (e as Error)?.message }),
    }).catch(() => undefined);
    return;
  }
  if (!raw) return;

  const snapshot = parseSnapshot(raw);
  if (!snapshot) {
    await logToAxiom({
      type: 'metric-reconciliation',
      name: 'reaction-exactness-republish',
      level: 'error',
      message: 'nightly exactness snapshot failed validation — gauges not re-published',
      error: JSON.stringify({ raw: raw.slice(0, 500) }),
    }).catch(() => undefined);
    return;
  }
  publishNightlyExactnessGauges(snapshot);
}

function floorToHour(date: Date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export const reactionVolumeAuditJob = createJob(
  'reaction-volume-audit',
  '10 * * * *',
  async (jobContext) => {
    const hourStart = floorToHour(new Date(Date.now() - AUDIT_LAG_HOURS * 3_600_000));
    const result = await auditReactionHour(hourStart, {
      checkCanceled: jobContext.checkIfCanceled,
    });

    gauges.hourly_missing_rows.set(result.missing);
    gauges.hourly_unmapped_rows.set(
      Object.values(result.unknownReactions).reduce((a, b) => a + b, 0)
    );
    // An hour with no reactions has undefined coverage. Leaving the gauge at its
    // previous value beats publishing a 0 that would page for a quiet hour.
    if (result.coverage !== null) gauges.hourly_coverage_ratio.set(result.coverage);
    // Last, and after every value above. Alert queries pick the pod with the freshest
    // anchor and then read its values, so the anchor must never be newer than they are.
    gauges.audit_last_run_timestamp_seconds.set(Date.now() / 1000);

    /**
     * Strictly after the anchor, never between it and the values. This is an `await`, so
     * the process can serve /api/metrics from the same prom registry while it is pending;
     * placed earlier, a scrape landing in that window on a pod's first run after a roll
     * would see a fresh anchor beside a coverage gauge still at prom-client's default 0,
     * and the freshest-pod query would read that 0 as a total CDC loss.
     *
     * A failure here must not fail the hourly audit — the reconciliation is the job, the
     * re-publish is a convenience for the nightly's panels.
     */
    await republishNightlyExactnessGauges().catch(() => undefined);

    const breached = result.coverage !== null && result.coverage < COVERAGE_WARN;
    if (breached || Object.keys(result.unknownReactions).length > 0) {
      await logToAxiom({
        type: 'metric-reconciliation',
        name: 'reaction-volume-audit',
        level: result.coverage !== null && result.coverage < COVERAGE_CRIT ? 'error' : 'warn',
        message: `reaction coverage ${result.coverage} for hour ${hourStart.toISOString()}`,
        error: JSON.stringify({
          hourStart: hourStart.toISOString(),
          coverage: result.coverage,
          pgRows: result.pgRows,
          missing: result.missing,
          unknownReactions: result.unknownReactions,
          affectedImages: result.affectedImageIds.length,
          sampleImageIds: result.affectedImageIds.slice(0, 20),
        }),
      }).catch(() => undefined);

      await requestReactionRepair({
        imageIds: result.affectedImageIds,
        reason: 'hourly-coverage',
        detectedAt: new Date(),
        windowStart: hourStart,
        windowEnd: new Date(hourStart.getTime() + 3_600_000),
      });
    }

    return {
      hourStart: hourStart.toISOString(),
      pgRows: result.pgRows,
      missing: result.missing,
      coverage: result.coverage,
      affectedImages: result.affectedImageIds.length,
      durationMs: result.durationMs,
    };
  },
  { dedicated: true, lockExpiration: 10 * 60 }
);

export const reactionExactnessAuditJob = createJob(
  'reaction-exactness-audit',
  '40 4 * * *',
  async () => {
    // The sample is a stable hash ordering, not a random draw, so a fixed seed
    // would inspect the same images every night. Vary it by day.
    const seed = Math.floor(Date.now() / 86_400_000);
    const result = await auditReactionExactness({ sampleSize: 200, lookbackHours: 24, seed });

    const snapshot: NightlyExactnessSnapshot = {
      ranAt: Date.now() / 1000,
      recentCoverage: result.recentCoverage,
      backlogCoverage: result.backlogCoverage,
      phantomRate: result.phantomRate,
      recentPairs: result.recentPairs,
    };
    publishNightlyExactnessGauges(snapshot);
    // Logged, not swallowed: a silently-failed write leaves the hourly re-publishing an
    // older snapshot, which rewinds the freshness stamp and serves stale coverage as
    // current — the one outcome worse than the gauges being absent.
    await sysRedis
      .set(REDIS_SYS_KEYS.METRIC_RECONCILIATION.NIGHTLY_EXACTNESS, JSON.stringify(snapshot))
      .catch((e) =>
        logToAxiom({
          type: 'metric-reconciliation',
          name: 'reaction-exactness-audit',
          level: 'warn',
          message: 'could not persist the nightly exactness snapshot',
          error: JSON.stringify({ error: (e as Error)?.message }),
        }).catch(() => undefined)
      );

    if (result.missingInCh > 0) {
      await requestReactionRepair({
        imageIds: result.affectedImageIds,
        reason: 'nightly-exactness',
        detectedAt: new Date(),
      });
    }

    await logToAxiom({
      type: 'metric-reconciliation',
      name: 'reaction-exactness-audit',
      level:
        result.recentCoverage !== null && result.recentCoverage < COVERAGE_WARN ? 'warn' : 'info',
      message: `reaction exactness recent ${result.recentCoverage} backlog ${result.backlogCoverage} phantom ${result.phantomRate}`,
      error: JSON.stringify({
        ...result,
        affectedImageIds: undefined,
        sampleImageIds: result.affectedImageIds.slice(0, 20),
      }),
    }).catch(() => undefined);

    return { ...result, affectedImageIds: result.affectedImageIds.length };
  },
  { dedicated: true, lockExpiration: 15 * 60 }
);

export const metricReconciliationJobs = [reactionVolumeAuditJob, reactionExactnessAuditJob];
