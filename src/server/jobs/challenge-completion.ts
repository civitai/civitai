import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getEndedActiveChallenges,
  getChallengeConfig,
  getChallengesToReconcile,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { reconcileCompletedChallenge } from '~/server/games/daily-challenge/challenge-rewards';
import { resetStuckCompletingChallenges } from '~/server/games/daily-challenge/challenge-helpers';
import { pickWinnersForChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { CHALLENGE_JOB_CONCURRENCY } from '~/shared/constants/challenge.constants';

const log = createLogger('jobs:challenge-completion', 'blue');

// Extracted so tests can invoke the job body directly (bypassing the cron/lock wrapper from
// createJob) — mirrors the reviewEntries() export in daily-challenge-processing.ts.
export async function runChallengeCompletion() {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

  // Recovery: reset challenges stuck in Completing for more than 10 minutes.
  // Note: this check runs hourly, so actual recovery time is up to ~70 min.
  const resetCount = await resetStuckCompletingChallenges(10);
  if (resetCount > 0) {
    log(`Recovery: reset ${resetCount} stuck Completing challenge(s) back to Active`);
  }

  const config = await getChallengeConfig();

  const endedChallenges = await getEndedActiveChallenges();
  if (endedChallenges.length) {
    log(`Completing ${endedChallenges.length} challenge(s)`);

    // Winner-pick is claim-guarded (claimChallengeForCompletion), so concurrent processing is
    // safe. Each task isolates its own error so one failing challenge can't abort the rest.
    await limitConcurrency(
      endedChallenges.map((challenge) => async () => {
        try {
          await pickWinnersForChallenge(challenge, config);
        } catch (error) {
          const err = error as Error;
          logToAxiom({
            type: 'error',
            name: 'challenge-completion',
            message: err.message,
            challengeId: challenge.challengeId,
          });
          log(`Failed to complete challenge ${challenge.challengeId}:`, error);
        }
      }),
      CHALLENGE_JOB_CONCURRENCY
    );
  }

  // Reconciliation: back-pay participation prizes for entries rated after completion.
  const toReconcile = await getChallengesToReconcile();
  if (toReconcile.length) {
    log(`Reconciling ${toReconcile.length} recently-completed challenge(s)`);
    await limitConcurrency(
      toReconcile.map((challenge) => async () => {
        try {
          const { promoted, paid, buzzGranted } = await reconcileCompletedChallenge(
            challenge,
            config
          );
          if (promoted > 0 || paid > 0) {
            log(
              `Reconciled challenge ${challenge.challengeId}: promoted=${promoted} paid=${paid} buzzGranted=${buzzGranted}`
            );
          }
        } catch (error) {
          const err = error as Error;
          logToAxiom({
            type: 'error',
            name: 'challenge-reconciliation',
            message: err.message,
            challengeId: challenge.challengeId,
          });
          log(`Failed to reconcile challenge ${challenge.challengeId}:`, error);
        }
      }),
      CHALLENGE_JOB_CONCURRENCY
    );
  }
}

export const challengeCompletionJob = createJob(
  'challenge-completion',
  '0 * * * *',
  runChallengeCompletion
);
