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
import { createUpcomingChallenge } from './daily-challenge-processing';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

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
  // Note: Only Scheduled and Active challenges count toward the horizon.
  // Draft challenges are not counted - they must be explicitly scheduled.
  const scheduledDates = await dbRead.$queryRaw<{ date: Date }[]>`
    SELECT DISTINCT DATE_TRUNC('day', "startsAt") as date
    FROM "Challenge"
    WHERE "startsAt" >= ${startDate.toDate()}
    AND "startsAt" <= ${endDate.toDate()}
    AND status IN (
      ${ChallengeStatus.Scheduled}::"ChallengeStatus",
      ${ChallengeStatus.Active}::"ChallengeStatus"
    )
  `;

  const scheduledDateSet = new Set(scheduledDates.map((d) => dayjs(d.date).format('YYYY-MM-DD')));

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
  // Check if challenge platform is enabled
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) {
    log('Challenge platform disabled, skipping job');
    return { created: 0, skipped: 0 };
  }

  log('Starting challenge auto-queue job...');

  // Get dates that need challenges
  const missingDates = await getDatesWithoutChallenges(HORIZON_DAYS);

  if (missingDates.length === 0) {
    log('All dates in horizon have challenges scheduled');
    return { created: 0, skipped: HORIZON_DAYS };
  }

  log(`Found ${missingDates.length} dates without challenges`);

  // Create challenges for missing dates with rate limiting
  // Process sequentially to avoid overwhelming AI APIs
  let created = 0;
  let failed = 0;

  for (const targetDate of missingDates) {
    try {
      const dateStr = dayjs(targetDate).format('YYYY-MM-DD');
      log(`Creating challenge for ${dateStr}...`);

      const challenge = await createUpcomingChallenge(targetDate);

      if (challenge) {
        created++;
        log(`Successfully created challenge for ${dateStr}`);
      } else {
        log(`Skipped ${dateStr} (may already exist)`);
      }

      // Rate limit: wait between AI API calls to avoid overwhelming services
      // Each challenge makes 2 AI calls (generateCollectionDetails, generateArticle)
      if (missingDates.indexOf(targetDate) < missingDates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
      }
    } catch (error) {
      failed++;
      const err = error as Error;
      log(
        `Failed to create challenge for ${dayjs(targetDate).format('YYYY-MM-DD')}: ${err.message}`
      );
      // Continue with next date instead of failing entire job
    }
  }

  log(`Auto-queue complete: ${created} created, ${failed} failed`);

  return {
    horizonDays: HORIZON_DAYS,
    created,
    failed,
    filledCount: HORIZON_DAYS - missingDates.length + created,
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
    statusBreakdown: statusCounts.reduce((acc, { status, count }) => {
      acc[status] = Number(count);
      return acc;
    }, {} as Record<string, number>),
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
