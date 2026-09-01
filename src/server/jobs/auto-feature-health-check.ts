/**
 * Alerts when the auto-feature job has silently stopped topping up the Featured Images collection.
 *
 * `auto-feature-images` logs a `job-summary` on every run, including a zero-pick one. That covers a
 * run that came up short; it cannot cover a run that never happened. During the 79-hour silence
 * ending 17 Aug 2026 nothing was emitted from anywhere, because nothing executed — and a job that
 * never starts produces exactly the evidence a healthy quiet system produces.
 *
 * So this reads state the producer leaves behind rather than instrumenting the producer:
 *
 * - **`lastRow`** — the newest row the job wrote into its target collection. Its output.
 * - **`lastRun`** — the `KeyValue` row `getJobDate` advances. Its heartbeat.
 *
 * Both are plain table reads, answerable with the job dead, which is the whole point. They fail
 * differently and are reported differently: a stale heartbeat means the job is not executing (or is
 * bailing before it scores, which `setLastRun` deliberately does not count as a run), while a fresh
 * heartbeat over a stale output means it runs and picks nothing — legitimate when the caps are
 * doing their job, so that one is recorded rather than paged.
 *
 * 🔴 **To verify this, do NOT turn off the `AUTO_FEATURE_IMAGES` flag.** That is the obvious reading
 * of "suppress the job and observe the alert", and it produces no alert BY DESIGN — the flag gate
 * below returns before anything is evaluated, and the Axiom "Skipped" line it leaves reads like a
 * pass. What works, and what was used:
 *
 *   1. note the current value of `KeyValue['job:auto-feature-images']`
 *   2. set it back a day
 *   3. `GET /api/webhooks/run-jobs/auto-feature-health-check?token=$WEBHOOK_TOKEN` — the endpoint
 *      selects one job by name, so this runs the check alone and immediately
 *   4. observe the Discord page, then restore the value
 *
 * Three limits worth knowing before tuning anything here:
 *
 * - **The threshold's margin collapses at the bottom of the config's range.** The producer stamps
 *   its heartbeat during a run, so the next hourly wake is always fractionally short of the gate
 *   and gets skipped: real spacing is `intervalHours + 1`, against a threshold of
 *   `2 * intervalHours + 1`. That leaves `intervalHours` hours of slack — six missed wakes at
 *   today's 6, but only one at the schema's minimum of 1. At the maximum of 168 the threshold is
 *   14 days, which would not have caught the 79-hour August outage at all.
 * - **This shares two control planes with the job it watches.** `isFlipt` returns false when Flipt
 *   is unreachable, so a Flipt outage stops the producer and silences this check in the same
 *   instant; the flag-off path logs the heartbeat age so that case leaves a trace. More likely, it
 *   rides the same scheduler and the same `run-jobs` endpoint, so a failure in *that* layer takes
 *   both down together. For the August outage specifically that was not the cause — other crons
 *   logged continuously through all 79 hours — but nothing here would catch a scheduler-wide stop.
 * - **`job_duration_seconds_count` already detects half of this.** It increments on every
 *   invocation and `seedJobMetrics` makes an absent series distinguishable from an idle one, so
 *   `rate(...[6h]) == 0` catches a job that stopped executing with no code at all. It is not enough
 *   on its own: it counts the `flag-off` and `interval-not-elapsed` early returns, so it cannot see
 *   a job that runs but never scores, nor one that scores but writes nothing. This repo also cannot
 *   ship a Prometheus alert rule — see `clickhouse-refresh-monitor.ts`, which hit the same wall and
 *   wrote its PromQL in a comment.
 */

import {
  AUTO_FEATURE_DEFAULT_INTERVAL_HOURS,
  AUTO_FEATURE_JOB_DATE_KEY,
  AUTO_FEATURE_NOTE_PREFIX,
  getAutoFeatureBlockConfig,
  getAutoFeatureUserId,
} from '~/server/common/auto-feature';
import { notifyModAlert } from '~/server/common/mod-alert';
import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('jobs:auto-feature-health-check', 'yellow');

/**
 * How many configured intervals may pass before silence counts as a fault.
 *
 * The producer wakes hourly and fires on `intervalHours`, so a legitimate gap is up to one wake
 * longer than the interval itself — measured at 6-7h in production against a 6h setting. Two
 * intervals plus that wake is 13h at today's config: clear of the real spacing, and it catches a
 * repeat of the 79-hour August outage inside its first day.
 */
const STALE_INTERVALS = 2;
const WAKE_SLACK_HOURS = 1;

type AutoFeatureHealth = {
  lastRow: Date | null;
  lastRun: Date | null;
  /**
   * Whether `lastRow` is an answer about the job's output at all. False when there is no config or
   * no attribution account, where a null `lastRow` means "could not look" rather than "wrote
   * nothing" — a distinction the record alert would otherwise blame the caps for.
   */
  rowsReadable: boolean;
  staleAfterHours: number;
  dryRun: boolean;
  collectionId: number | null;
};

async function readLastRun() {
  const row = await dbRead.keyValue.findUnique({ where: { key: AUTO_FEATURE_JOB_DATE_KEY } });
  if (!row) return null;
  // `KeyValue.value` is untyped Json and other keys in the table hold arrays and strings. The
  // `typeof` test is load-bearing rather than defensive: `Number(['1'])` is `1`, so a coercion
  // alone turns a one-element array into a plausible 1970 timestamp instead of rejecting it.
  // `getJobDate` only ever writes `date.getTime()`, so anything that is not a number is not a
  // heartbeat this job can reason about.
  const ms = row.value;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * `COALESCE(reviewedAt, createdAt)` because that is the timestamp the producer itself treats as
 * when a row landed. Taking `max` of the two columns separately is not the same value, and the two
 * only agree while `reviewedAt` happens to be null.
 *
 * 🔴 `status = 'ACCEPTED'` is what makes that safe. Removing an auto-featured image tombstones the
 * row rather than deleting it — `status` goes REJECTED and `reviewedAt` is stamped `now()`, while
 * `addedById` and the note survive. Without this clause a moderator clearing out stale features,
 * which is exactly what someone does while the pipeline is dry, would push `lastRow` to the present
 * and silence the check indefinitely. One such tombstone already exists in the target collection.
 * `buildWindowCountsQuery` filters the same way for the same reason.
 */
async function readLastRow(collectionId: number, autoFeatureUserId: number) {
  const [row] = await dbRead.$queryRaw<{ lastRow: Date | null }[]>`
    SELECT max(COALESCE(ci."reviewedAt", ci."createdAt")) AS "lastRow"
    FROM "CollectionItem" ci
    WHERE ci."collectionId" = ${collectionId}
      AND ci."addedById" = ${autoFeatureUserId}
      AND ci.status = 'ACCEPTED'::"CollectionItemStatus"
      AND ci.note LIKE ${`${AUTO_FEATURE_NOTE_PREFIX}:%`}
  `;
  return row?.lastRow ?? null;
}

export async function readAutoFeatureHealth(): Promise<AutoFeatureHealth> {
  const resolved = await getAutoFeatureBlockConfig();
  const config = resolved?.config ?? null;
  const intervalHours = config?.intervalHours ?? AUTO_FEATURE_DEFAULT_INTERVAL_HOURS;
  const collectionId = config?.collectionId ?? null;

  const autoFeatureUserId = collectionId === null ? null : await getAutoFeatureUserId();
  // Only meaningful when there is a collection to look in AND an account to attribute rows to.
  // Without both, `lastRow` would be null for a reason that has nothing to do with the job's
  // output, and a null read as "wrote nothing" names a cause that is not the one.
  const canReadRows = collectionId !== null && autoFeatureUserId !== null;
  const [lastRun, lastRow] = await Promise.all([
    readLastRun(),
    canReadRows ? readLastRow(collectionId, autoFeatureUserId) : Promise.resolve(null),
  ]);

  return {
    lastRow,
    lastRun,
    rowsReadable: canReadRows,
    staleAfterHours: intervalHours * STALE_INTERVALS + WAKE_SLACK_HOURS,
    dryRun: config?.dryRun ?? true,
    collectionId,
  };
}

const hoursSince = (date: Date | null, now: Date) =>
  date === null ? null : (now.getTime() - date.getTime()) / 3_600_000;

const describeAge = (date: Date | null, now: Date) => {
  const hours = hoursSince(date, now);
  return hours === null ? 'never' : `${date!.toISOString()} (${hours.toFixed(1)}h ago)`;
};

export type AutoFeatureAlert = { severity: 'page' | 'record'; message: string };

/**
 * A missing timestamp is stale, not unknown. "The job has never run" and "the job last ran in
 * March" are the same outage from the homepage's side, and treating null as inconclusive is how a
 * check that cannot fire gets written.
 */
export function evaluateAutoFeatureHealth(
  health: AutoFeatureHealth,
  now: Date
): AutoFeatureAlert[] {
  const alerts: AutoFeatureAlert[] = [];
  const { staleAfterHours } = health;

  const runAge = hoursSince(health.lastRun, now);
  if (runAge === null || runAge > staleAfterHours) {
    alerts.push({
      severity: 'page',
      message:
        `**No completed run** — \`auto-feature-images\` has not scored a run in ${staleAfterHours}h. ` +
        `Last run: ${describeAge(health.lastRun, now)}. ` +
        `Either it is not executing, or it is executing and bailing first — most often \`no-eligible-collections\`, ` +
        `where the whole featured pool has gone stale and the homepage block hides itself. ` +
        `Its \`job-misconfigured\` events name which; an empty pool is fixed by curation, not by the job.`,
    });
  }

  // Only meaningful once the heartbeat says the job is alive. Reporting both when the job is dead
  // would be one outage described twice, and the second line names a cause that is not the one.
  const rowAge = hoursSince(health.lastRow, now);
  const heartbeatHealthy = runAge !== null && runAge <= staleAfterHours;
  if (
    heartbeatHealthy &&
    health.rowsReadable &&
    !health.dryRun &&
    (rowAge === null || rowAge > staleAfterHours)
  ) {
    alerts.push({
      severity: 'record',
      message:
        `**Running but not writing** — no auto-featured row in collection ${
          health.collectionId ?? 'unknown'
        } for ${staleAfterHours}h ` +
        `while the job is still running. Last row: ${describeAge(health.lastRow, now)}. ` +
        `Expected when the per-creator or per-collection caps refuse everything; a fault if candidates have dried up.`,
    });
  }

  return alerts;
}

export async function checkAutoFeatureHealth() {
  // The flag being off makes the producer return before it touches anything, by design, so its
  // silence is then expected rather than a fault. Still recorded: it is the likeliest explanation
  // for a homepage that has stopped changing, and the person looking should be able to find it.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.AUTO_FEATURE_IMAGES))) {
    // `isFlipt` cannot tell "deliberately off" from "Flipt unreachable" — both are false. So the
    // heartbeat goes out with it: a flag that reads off while the job last ran months ago is the
    // shape of an outage in the control plane, and this line is the only trace of it.
    const lastRun = await readLastRun().catch(() => null);
    log('Auto-feature flag off, skipping health check');
    await logToAxiom({
      type: 'info',
      name: 'auto-feature-health-check',
      message: 'Skipped: AUTO_FEATURE_IMAGES reads off (deliberately, or because Flipt is down)',
      details: { lastRun: lastRun?.toISOString() ?? null },
    }).catch(() => null);
    return { skipped: true as const, lastRun: lastRun?.toISOString() ?? null };
  }

  const health = await readAutoFeatureHealth();
  const alerts = evaluateAutoFeatureHealth(health, new Date());

  const details = {
    lastRun: health.lastRun?.toISOString() ?? null,
    lastRow: health.lastRow?.toISOString() ?? null,
    staleAfterHours: health.staleAfterHours,
    dryRun: health.dryRun,
    collectionId: health.collectionId,
  };

  if (alerts.length === 0) {
    log('Auto-feature pipeline healthy');
    return { healthy: true as const, ...details };
  }

  await logToAxiom({
    type: alerts.some((a) => a.severity === 'page') ? 'warning' : 'info',
    name: 'auto-feature-health-check',
    details,
    message: alerts.map((a) => a.message).join(' | '),
  }).catch(() => null);

  const paging = alerts.filter((a) => a.severity === 'page');
  // `paged` reports what LANDED, not what was attempted. A revoked or rotated webhook otherwise
  // leaves this job returning `paged: 1` forever while nobody is being told — the outage detector
  // having its own silent outage, which is the exact failure the job exists to make visible.
  const delivered =
    paging.length > 0 &&
    (await notifyModAlert(
      `🚨 Auto-feature pipeline — ${paging.length} check(s) failing`,
      paging.map((a) => a.message).join('\n\n')
    ));

  if (paging.length > 0 && !delivered)
    await logToAxiom({
      type: 'warning',
      name: 'auto-feature-health-check',
      message: 'Discord alert did not land — the page above reached nobody',
    }).catch(() => null);

  return {
    healthy: false as const,
    alerts: alerts.length,
    paged: delivered ? paging.length : 0,
    ...details,
  };
}

/**
 * Every 3 hours: half the shortest cadence the config permits at today's setting, so a threshold
 * crossing is noticed within one interval of it happening rather than a day later.
 */
export const autoFeatureHealthCheckJob = createJob(
  'auto-feature-health-check',
  '40 */3 * * *',
  checkAutoFeatureHealth
);
