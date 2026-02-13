import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getChallengesReadyToStart,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { startScheduledChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';

const log = createLogger('jobs:challenge-activation', 'blue');

export const challengeActivationJob = createJob('challenge-activation', '* * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

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
