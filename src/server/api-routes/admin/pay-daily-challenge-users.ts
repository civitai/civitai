import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import * as z from 'zod';

import { getChallengeById } from '~/server/games/daily-challenge/challenge-helpers';
import { challengeToLegacyFormat } from '~/server/games/daily-challenge/daily-challenge.utils';
import { withRetries } from '~/utils/errorHandling';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { numericString } from '~/utils/zod-helpers';
import dayjs from '~/shared/utils/dayjs';

const schema = z.object({
  challengeId: numericString(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const challengeRecord = await getChallengeById(result.data.challengeId);
  if (!challengeRecord) return res.status(404).json({ error: 'Challenge not found' });
  const challenge = challengeToLegacyFormat(challengeRecord);

  const earnedPrizes = await dbWrite.$queryRaw<{ userId: number; count: number }[]>`
    SELECT
    i."userId",
    COUNT(*) as count
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE
      ci."collectionId" = ${challenge.collectionId}
      AND ci.status = 'ACCEPTED'
    GROUP BY 1
    HAVING COUNT(*) >= ${challenge.entryPrizeRequirement};
  `;

  if (earnedPrizes.length > 0) {
    await withRetries(() =>
      createBuzzTransactionMany(
        earnedPrizes.map(({ userId }) => ({
          type: TransactionType.Reward,
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount: challenge.entryPrize.buzz,
          description: `Challenge Entry Prize: ${challenge.title}`,
          externalTransactionId: `challenge-entry-prize-${challenge.challengeId}-${userId}`,
          toAccountType: 'blue',
        }))
      )
    );

    console.log('Buzz transactions created');
  }

  return res.status(200).json({ data: { success: true } });
});
