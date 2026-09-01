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
 * Two limits worth knowing before tuning anything here:
 *
 * - **The threshold's margin collapses at the bottom of the config's range.** The producer stamps
 *   its heartbeat during a run, so the next hourly wake is always fractionally short of the gate
 *   and gets skipped: real spacing is `intervalHours + 1`, against a threshold of
 *   `2 * intervalHours + 1`. That leaves `intervalHours` hours of slack — six missed wakes at
 *   today's 6, but only one at the schema's minimum of 1. At the maximum of 168 the threshold is
 *   14 days, which would not have caught the 79-hour August outage at all.
 * - **This shares a control plane with the job it watches.** `isFlipt` returns false when Flipt is
 *   unreachable, so a Flipt outage stops the producer and silences this check in the same instant.
 *   The flag-off path logs the heartbeat age precisely so that case leaves a trace to search for.
 */

import { env } from '~/env/server';
import {
  AUTO_FEATURE_JOB_DATE_KEY,
  AUTO_FEATURE_NOTE_PREFIX,
  getAutoFeatureUserId,
} from '~/server/common/auto-feature';
import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { autoFeatureSchema } from '~/server/schema/home-block.schema';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
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

/**
 * Used only when the home block's config cannot be read. Matches `autoFeatureSchema`'s own default
 * so a missing config produces the threshold the job would itself have run at — a config that has
 * gone missing is a fault the producer cannot report while it is not running, and refusing to check
 * without one would blind this job to precisely that.
 */
const DEFAULT_INTERVAL_HOURS = 6;

type AutoFeatureHealth = {
  lastRow: Date | null;
  lastRun: Date | null;
  staleAfterHours: number;
  dryRun: boolean;
  collectionId: number | null;
};

async function readAutoFeatureConfig() {
  const block = await dbRead.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: { metadata: true },
    orderBy: { id: 'asc' },
  });
  const metadata = (block?.metadata || {}) as HomeBlockMetaSchema;
  const parsed = autoFeatureSchema.safeParse(metadata.featuredCollections?.autoFeature);
  return parsed.success ? parsed.data : null;
}

async function readLastRun() {
  const row = await dbRead.keyValue.findUnique({ where: { key: AUTO_FEATURE_JOB_DATE_KEY } });
  if (!row) return null;
  const ms = Number(row.value);
  // `KeyValue.value` is untyped Json. A row holding anything but a millisecond number is not a
  // timestamp this job can reason about, and treating it as epoch 0 would page forever.
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
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
  const config = await readAutoFeatureConfig();
  const intervalHours = config?.intervalHours ?? DEFAULT_INTERVAL_HOURS;
  const collectionId = config?.collectionId ?? null;

  const autoFeatureUserId = collectionId === null ? null : await getAutoFeatureUserId();
  const [lastRun, lastRow] = await Promise.all([
    readLastRun(),
    collectionId !== null && autoFeatureUserId !== null
      ? readLastRow(collectionId, autoFeatureUserId)
      : Promise.resolve(null),
  ]);

  return {
    lastRow,
    lastRun,
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
  if (heartbeatHealthy && !health.dryRun && (rowAge === null || rowAge > staleAfterHours)) {
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

async function alertDiscord(title: string, description: string) {
  if (!env.DISCORD_WEBHOOK_MOD_ALERTS) return;

  await fetch(env.DISCORD_WEBHOOK_MOD_ALERTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ title, description, color: 0xf44336, timestamp: new Date().toISOString() }],
    }),
  }).catch(() => null);
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
  if (paging.length)
    await alertDiscord(
      `🚨 Auto-feature pipeline — ${paging.length} check(s) failing`,
      paging.map((a) => a.message).join('\n\n')
    );

  return { healthy: false as const, alerts: alerts.length, paged: paging.length, ...details };
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
