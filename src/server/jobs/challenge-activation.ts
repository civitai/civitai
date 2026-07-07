import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getChallengesReadyToStart,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { getBlockedUserChallengesPastStart } from '~/server/games/daily-challenge/challenge-helpers';
import { voidChallenge } from '~/server/services/challenge.service';
import { startScheduledChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';

const log = createLogger('jobs:challenge-activation', 'blue');

export const challengeActivationJob = createJob('challenge-activation', '0 * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

  // Void user challenges that reached their start time while hard-blocked by scan. They can
  // never activate (getChallengesReadyToStart excludes them), so void to refund + unstick them.
  const blockedIds = await getBlockedUserChallengesPastStart();
  for (const challengeId of blockedIds) {
    try {
      await voidChallenge(challengeId);
      log(`Voided blocked user challenge ${challengeId}`);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'challenge-activation-void-blocked',
        message: err.message,
        challengeId,
      });
      log(`Failed to void blocked challenge ${challengeId}:`, error);
    }
  }

  const challengesToStart = await getChallengesReadyToStart();
  if (!challengesToStart.length) return;

  const config = await getChallengeConfig();
  log(`Activating ${challengesToStart.length} challenge(s)`);

  for (const challenge of challengesToStart) {
    try {
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
  }
});
