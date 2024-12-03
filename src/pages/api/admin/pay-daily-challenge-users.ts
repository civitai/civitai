import { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';

import { dailyChallengeConfig as config } from '~/server/games/daily-challenge/daily-challenge.utils';
import { withRetries } from '~/utils/errorHandling';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { numericString } from '~/utils/zod-helpers';

const schema = z.object({
  collectionId: numericString(),
  date: z.string(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const earnedPrizes = await dbWrite.$queryRaw<{ userId: number; count: number }[]>`
    SELECT
    i."userId",
    COUNT(*) as count
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE
      ci."collectionId" = ${result.data.collectionId}
      AND ci.status = 'ACCEPTED'
    GROUP BY 1
    HAVING COUNT(*) >= ${config.entryPrizeRequirement};
  `;

  if (earnedPrizes.length > 0) {
    await withRetries(() =>
      createBuzzTransactionMany(
        earnedPrizes.map(({ userId }) => ({
          type: TransactionType.Reward,
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount: config.entryPrize.buzz,
          description: `Challenge Entry Prize: ${result.data.date}`,
          externalTransactionId: `challenge-entry-prize-${result.data.date}-${userId}`,
          toAccountType: 'generation',
        }))
      )
    );

    console.log('Buzz transactions created');
  }

  return res.status(200).json({ data: { success: true } });
});
