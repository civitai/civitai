/**
 * Alerts when the daily-challenge pipeline has silently stopped producing challenges.
 *
 * Replaces two Retool Workflows ("Daily Challenge Not Prepared" / "Not Started") that watched the same
 * two conditions. Their SQL is ported; their delivery is not — they paged PagerDuty, which this repo has
 * no integration for, and their Discord block was orphaned in the graph so it never fired.
 *
 * The gap this covers is specifically the SILENT one. `createJob` already reports a *thrown* failure to
 * Axiom and `jobErrorsCounter`, but the challenge jobs' common failure is a no-op — an early return, a
 * date that quietly failed inside a batch, or a job that was never invoked — and none of those raise.
 */

import { notifyModAlert } from '~/server/common/mod-alert';
import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('jobs:challenge-health-check', 'yellow');

const UPCOMING_WINDOW_HOURS = 48;

// Must exceed the 24h challenge cadence. This job shares the 00:00 tick with `challenge-activation`,
// so the incoming challenge is still `Scheduled` while the outgoing one's `startsAt` is already
// *exactly* 24h old — under a 24h window neither answers, which false-alarmed daily 2026-08-28..31.
const RECENT_WINDOW_HOURS = 26;

// A challenge that started and has since finished still answers "did one start" — the outgoing one
// is often mid-completion at the handover. `Scheduled` stays out: past its own `startsAt`, that IS
// the failure being watched for.
const STARTED_STATUSES = ['Active', 'Completing', 'Completed'];

type HealthRow = {
  hasUpcoming: boolean;
  hasRecent: boolean;
  nextScheduledAt: Date | null;
  lastActivatedAt: Date | null;
};

async function readChallengeHealth() {
  const [row] = await dbRead.$queryRaw<HealthRow[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM "Challenge"
        WHERE status = 'Scheduled' AND source = 'System'
          AND "startsAt" > now()
          AND "startsAt" < now() + (${UPCOMING_WINDOW_HOURS} || ' hours')::interval
      ) AS "hasUpcoming",
      EXISTS (
        SELECT 1 FROM "Challenge"
        WHERE status::text = ANY(${STARTED_STATUSES}::text[]) AND source = 'System'
          AND "startsAt" <= now()
          AND "startsAt" > now() - (${RECENT_WINDOW_HOURS} || ' hours')::interval
      ) AS "hasRecent",
      (
        SELECT min("startsAt") FROM "Challenge"
        WHERE status = 'Scheduled' AND source = 'System' AND "startsAt" > now()
      ) AS "nextScheduledAt",
      (
        SELECT max("startsAt") FROM "Challenge"
        WHERE status::text = ANY(${STARTED_STATUSES}::text[]) AND source = 'System'
          AND "startsAt" <= now()
      ) AS "lastActivatedAt"
  `;

  return row;
}

async function checkChallengeHealth() {
  // A disabled platform makes both producing jobs no-op by design, so paging on it is noise. It is
  // still the likeliest explanation for an empty schedule, so it goes to Axiom to be findable.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) {
    log('Challenge platform disabled, skipping health check');
    await logToAxiom({
      type: 'info',
      name: 'challenge-health-check',
      message: 'Skipped: CHALLENGE_PLATFORM_ENABLED is off',
    }).catch(() => null);
    return { skipped: true as const };
  }

  const health = await readChallengeHealth();
  const failures: string[] = [];

  if (!health.hasUpcoming) {
    failures.push(
      `**Not prepared** — no \`Scheduled\` system challenge starts in the next ${UPCOMING_WINDOW_HOURS}h. ` +
        `Check \`challenge-auto-queue\` (0 6 * * *) and \`daily-challenge-setup\` (0 22 * * *). ` +
        `Next scheduled: ${health.nextScheduledAt?.toISOString() ?? 'none at all'}.`
    );
  }

  if (!health.hasRecent) {
    failures.push(
      `**Not started** — no system challenge began in the last ${RECENT_WINDOW_HOURS}h. ` +
        `Check \`challenge-activation\` (0 * * * *). ` +
        `Last activated: ${health.lastActivatedAt?.toISOString() ?? 'never'}.`
    );
  }

  if (!failures.length) {
    log('Challenge pipeline healthy');
    return { healthy: true as const, ...health };
  }

  log(`Challenge pipeline unhealthy: ${failures.length} condition(s)`);

  await logToAxiom({
    type: 'warning',
    name: 'challenge-health-check',
    details: {
      hasUpcoming: health.hasUpcoming,
      hasRecent: health.hasRecent,
      nextScheduledAt: health.nextScheduledAt?.toISOString() ?? null,
      lastActivatedAt: health.lastActivatedAt?.toISOString() ?? null,
    },
    message: failures.join(' | '),
  }).catch(() => null);

  await notifyModAlert(
    `🚨 Daily challenge pipeline — ${failures.length} check(s) failing`,
    failures.join('\n\n')
  );

  return { healthy: false as const, failures: failures.length, ...health };
}

export const challengeHealthCheckJob = createJob(
  'challenge-health-check',
  '0 */6 * * *',
  checkChallengeHealth
);

export { checkChallengeHealth };
