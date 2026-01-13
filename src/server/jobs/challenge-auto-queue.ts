/**
 * Challenge Auto-Queue Job
 *
 * This job maintains a 30-day horizon of scheduled challenges.
 * It runs daily and creates challenges for any day that doesn't have one scheduled.
 */

import dayjs from '~/shared/utils/dayjs';
import { dbRead } from '~/server/db/client';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('jobs:challenge-auto-queue', 'cyan');

// Configuration
const HORIZON_DAYS = 30; // How many days ahead to maintain challenges

/**
 * Get dates in the next N days that don't have any challenges scheduled
 */
async function getDatesWithoutChallenges(horizonDays: number): Promise<Date[]> {
  const startDate = dayjs().utc().add(1, 'day').startOf('day');
  const endDate = dayjs().utc().add(horizonDays, 'day').endOf('day');

  // Get all dates that have challenges scheduled
  const scheduledDates = await dbRead.$queryRaw<{ date: Date }[]>`
    SELECT DISTINCT DATE_TRUNC('day', "startsAt") as date
    FROM "Challenge"
    WHERE "startsAt" >= ${startDate.toDate()}
    AND "startsAt" <= ${endDate.toDate()}
    AND status IN (
      ${ChallengeStatus.Draft}::"ChallengeStatus",
      ${ChallengeStatus.Scheduled}::"ChallengeStatus",
      ${ChallengeStatus.Active}::"ChallengeStatus"
    )
  `;

  const scheduledDateSet = new Set(
    scheduledDates.map((d) => dayjs(d.date).format('YYYY-MM-DD'))
  );

  // Find dates without challenges
  const missingDates: Date[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const date = dayjs().utc().add(i, 'day').startOf('day');
    const dateStr = date.format('YYYY-MM-DD');
    if (!scheduledDateSet.has(dateStr)) {
      missingDates.push(date.toDate());
    }
  }

  return missingDates;
}

/**
 * Main job function - ensures challenges exist for the next 30 days
 */
async function ensureChallengeHorizon() {
  log('Starting challenge auto-queue job...');

  // Get dates that need challenges
  const missingDates = await getDatesWithoutChallenges(HORIZON_DAYS);

  if (missingDates.length === 0) {
    log('All dates in horizon have challenges scheduled');
    return { created: 0, skipped: HORIZON_DAYS };
  }

  log(`Found ${missingDates.length} dates without challenges`);

  // For now, we'll call the existing createUpcomingChallenge logic
  // which creates one challenge at a time. The daily setup job handles this.
  // This job just reports the gaps.

  // In a full implementation, we would:
  // 1. Import createUpcomingChallenge and refactor it to accept a targetDate
  // 2. Call it for each missing date
  // 3. Handle rate limits to avoid overwhelming AI APIs

  // For Phase 1, we just ensure the existing job runs daily and
  // log any gaps for moderators to fill manually

  const gaps = missingDates.map((d) => dayjs(d).format('YYYY-MM-DD'));
  log(`Challenge gaps detected for dates: ${gaps.join(', ')}`);

  // Return stats for monitoring
  return {
    horizonDays: HORIZON_DAYS,
    missingDates: gaps,
    missingCount: missingDates.length,
    filledCount: HORIZON_DAYS - missingDates.length,
  };
}

/**
 * Get horizon status for moderator dashboard
 */
export async function getChallengeHorizonStatus() {
  const missingDates = await getDatesWithoutChallenges(HORIZON_DAYS);

  // Get counts by status
  const statusCounts = await dbRead.$queryRaw<{ status: ChallengeStatus; count: bigint }[]>`
    SELECT status, COUNT(*) as count
    FROM "Challenge"
    WHERE "startsAt" >= NOW()
    AND "startsAt" <= NOW() + INTERVAL '${HORIZON_DAYS} days'
    GROUP BY status
  `;

  return {
    horizonDays: HORIZON_DAYS,
    missingDates: missingDates.map((d) => dayjs(d).format('YYYY-MM-DD')),
    missingCount: missingDates.length,
    coverage: Math.round(((HORIZON_DAYS - missingDates.length) / HORIZON_DAYS) * 100),
    statusBreakdown: statusCounts.reduce(
      (acc, { status, count }) => {
        acc[status] = Number(count);
        return acc;
      },
      {} as Record<string, number>
    ),
  };
}

// Create the job - runs daily at 6 AM UTC
export const challengeAutoQueueJob = createJob(
  'challenge-auto-queue',
  '0 6 * * *', // 6 AM UTC daily
  ensureChallengeHorizon
);

// Export for testing
export { ensureChallengeHorizon, getDatesWithoutChallenges };
