import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getEndedActiveChallenges,
  getChallengeConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import { pickWinnersForChallenge } from './daily-challenge-processing';
import { logToAxiom } from '~/server/logging/client';

const log = createLogger('jobs:challenge-completion', 'blue');

export const challengeCompletionJob = createJob('challenge-completion', '* * * * *', async () => {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) return;

  const endedChallenges = await getEndedActiveChallenges();
  if (!endedChallenges.length) return;

  const config = await getChallengeConfig();
  log(`Completing ${endedChallenges.length} challenge(s)`);

  for (const challenge of endedChallenges) {
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
  }
});
