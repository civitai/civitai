import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getChallengesReadyToStart,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  getUnscannedUserChallengesPastStart,
  setChallengeActive,
} from '~/server/games/daily-challenge/challenge-helpers';
import { scanUserChallenge, voidChallenge } from '~/server/services/challenge.service';
import { ChallengeIngestionStatus } from '~/shared/utils/prisma/enums';
import { startScheduledChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { CHALLENGE_JOB_CONCURRENCY } from '~/shared/constants/challenge.constants';

const log = createLogger('jobs:challenge-activation', 'blue');

// Pending/Error scans get re-scan attempts for this long past startsAt before the challenge is
// voided — bounds "stuck Scheduled+hidden with escrowed funds forever" when the scan service
// stays down, while giving transient failures time to recover.
const UNSCANNED_VOID_GRACE_MS = 24 * 60 * 60 * 1000;

// Extracted so tests can invoke the job body directly (bypassing the cron/lock wrapper from
// createJob) — mirrors runChallengeCompletion() in challenge-completion.ts.
export async function runChallengeActivation() {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

  // User challenges past start that never passed scan can't activate (getChallengesReadyToStart
  // requires Scanned). Blocked → void now (refunds fees + prize). Pending/Error → re-submit the
  // scan; it resolves asynchronously via the moderation webhook, so a later run activates it once
  // it reaches Scanned. Still unscanned after the grace window → void so the escrow isn't stranded.
  const unscanned = await getUnscannedUserChallengesPastStart();
  if (unscanned.length) {
    // Bounded concurrency; each task isolates its own error so one failing challenge can't
    // block the rest of the batch.
    await limitConcurrency(
      unscanned.map(({ id: challengeId, ingestion, startsAt }) => async () => {
        try {
          if (ingestion !== ChallengeIngestionStatus.Blocked) {
            await scanUserChallenge(challengeId);
            const gracePassed = Date.now() - startsAt.getTime() > UNSCANNED_VOID_GRACE_MS;
            const { ingestion: rescanned } =
              (await dbWrite.challenge.findUnique({
                where: { id: challengeId },
                select: { ingestion: true },
              })) ?? {};
            if (rescanned === ChallengeIngestionStatus.Scanned) {
              log(`Re-scan recovered user challenge ${challengeId}`);
              return;
            }
            if (rescanned !== ChallengeIngestionStatus.Blocked && !gracePassed) return;
          }
          await voidChallenge(challengeId);
          log(`Voided unscanned user challenge ${challengeId} (${ingestion})`);
        } catch (error) {
          const err = error as Error;
          logToAxiom({
            type: 'error',
            name: 'challenge-activation-void-blocked',
            message: err.message,
            challengeId,
          });
          log(`Failed to void unscanned challenge ${challengeId}:`, error);
        }
      }),
      CHALLENGE_JOB_CONCURRENCY
    );
  }

  const challengesToStart = await getChallengesReadyToStart();
  if (!challengesToStart.length) return;

  const config = await getChallengeConfig();
  log(`Activating ${challengesToStart.length} challenge(s)`);

  await limitConcurrency(
    challengesToStart.map((challenge) => async () => {
      try {
        // Conditional claim: a concurrent tick may have already activated this challenge
        // between getChallengesReadyToStart() and now. Only run activation side effects
        // (collection open, cosmetic grant, notification) if this call won the claim.
        const { activated } = await setChallengeActive(challenge.challengeId);
        if (!activated) {
          log(`Challenge ${challenge.challengeId} already activated by a concurrent tick, skipping`);
          return;
        }
        await startScheduledChallenge(challenge, config);
      } catch (error) {
        const err = error as Error;
        logToAxiom({
          type: 'error',
          name: 'challenge-activation',
          message: err.message,
          challengeId: challenge.challengeId,
        });
        log(`Failed to activate challenge ${challenge.challengeId}:`, error);
      }
    }),
    CHALLENGE_JOB_CONCURRENCY
  );
}

export const challengeActivationJob = createJob(
  'challenge-activation',
  '0 * * * *',
  runChallengeActivation
);
