import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { dbWrite } from '~/server/db/client';
import {
  endChallenge,
  getChallengeConfig,
  getChallengeDetails,
  getCurrentChallenge,
  setCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  createUpcomingChallenge,
  startNextChallenge,
} from '~/server/jobs/daily-challenge-processing';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  challengeId: z.coerce.number().optional(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // Get challenge to cycle
  let challenge: Awaited<ReturnType<typeof getCurrentChallenge>>;
  const { challengeId } = schema.parse(req.query);
  if (challengeId) {
    challenge = await getChallengeDetails(challengeId);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
  } else challenge = await getCurrentChallenge();

  // End challenge if it's not complete
  let shouldStartChallenge = false;
  if (challenge) {
    const results = await dbWrite.$queryRaw<{ status: string }[]>`
      SELECT
        (metadata->>'status') as status
      FROM "Article"
      WHERE id = ${challenge.articleId}
    `;
    if (results.length) {
      const status = results[0].status;
      shouldStartChallenge = status === 'active';
      if (status !== 'complete') {
        await endChallenge(challenge);
        await dbWrite.$executeRaw`
          DELETE FROM "Article" WHERE id = ${challenge.articleId}
        `;
      }
    }
  }

  try {
    const config = await getChallengeConfig();
    const newChallenge = await createUpcomingChallenge();
    if (shouldStartChallenge) {
      await startNextChallenge(config);
      await setCurrentChallenge(newChallenge.articleId);
    }
    res
      .status(200)
      .json({ message: 'Cycle complete', challengeId: challenge?.articleId, newChallenge });
  } catch (e) {
    console.error(e);
  }
});
