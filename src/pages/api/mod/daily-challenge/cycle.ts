import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import {
  endChallenge,
  getChallengeConfig,
  getCurrentChallenge,
  setCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  createUpcomingChallenge,
  startNextChallenge,
} from '~/server/jobs/daily-challenge-processing';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // Get current challenge
  const currentChallenge = await getCurrentChallenge();

  if (currentChallenge) {
    await endChallenge(currentChallenge);
    await dbWrite.$executeRaw`
      DELETE FROM article WHERE id = ${currentChallenge.articleId};
    `;
  }

  try {
    const config = await getChallengeConfig();
    const challenge = await createUpcomingChallenge();
    await startNextChallenge(config);
    await setCurrentChallenge(challenge.articleId);
  } catch (e) {
    console.error(e);
  }
});
