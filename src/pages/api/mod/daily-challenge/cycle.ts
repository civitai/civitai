import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import {
  getChallengeById,
  updateChallengeStatus,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  challengeToLegacyFormat,
  endChallenge,
  getChallengeConfig,
  getCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  createUpcomingChallenge,
  startNextChallenge,
} from '~/server/jobs/daily-challenge-processing';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  challengeId: z.coerce.number().optional(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // Get challenge to cycle
  let challenge: Awaited<ReturnType<typeof getCurrentChallenge>>;
  const { challengeId } = schema.parse(req.query);
  if (challengeId) {
    const challengeRecord = await getChallengeById(challengeId);
    if (!challengeRecord) return res.status(404).json({ error: 'Challenge not found' });
    challenge = challengeToLegacyFormat(challengeRecord);
  } else {
    challenge = await getCurrentChallenge();
  }

  // End challenge if it's not complete
  let shouldStartChallenge = false;
  if (challenge?.challengeId) {
    const [result] = await dbWrite.$queryRaw<{ status: string }[]>`
      SELECT status::text as status
      FROM "Challenge"
      WHERE id = ${challenge.challengeId}
    `;
    if (result) {
      const status = result.status;
      shouldStartChallenge = status === 'Active';
      if (status !== 'Completed') {
        await endChallenge(challenge);
        // Mark challenge as cancelled instead of deleting
        await updateChallengeStatus(challenge.challengeId, ChallengeStatus.Cancelled);
      }
    }
  }

  try {
    const config = await getChallengeConfig();
    const newChallenge = await createUpcomingChallenge();
    if (shouldStartChallenge) {
      await startNextChallenge(config);
    }
    res
      .status(200)
      .json({ message: 'Cycle complete', challengeId: challenge?.challengeId, newChallenge });
  } catch (e) {
    console.error(e);
  }
});
