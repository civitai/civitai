import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  bustCompensationPoolCache,
  getBanked,
  getCompensationPool,
  getMonthAccount,
} from '~/server/services/creator-program.service';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { numericString } from '~/utils/zod-helpers';

const schema = z.object({
  userId: numericString(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  // USE WITH THE UTMOST CARE PLEASE <3. NEVER RUN WITHOUT CONSULTING A DEV
  try {
    const data = schema.safeParse(req.query);

    if (!data.success) {
      return res.status(400).json({
        error: 'Invalid request body. Please provide a userId.',
        message:
          'This action will balance things out to return the bank to a 0 value. Do not use this lightly as many users could be left in limbo.',
      });
    }

    const { userId } = data.data;

    const user = await dbWrite.user.findUnique({
      where: {
        id: userId,
      },
    });

    if (!user || !user.isModerator) {
      return res.status(403).json({
        error: 'The user you are trying to reset is not a mod. This might be a mistake.',
      });
    }

    await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
    await bustCompensationPoolCache();

    const compensationPool = await getCompensationPool({});
    const currentValue = compensationPool.size.current;
    let change = currentValue;
    const monthAccount = getMonthAccount();

    if (userId) {
      // Get user's current balance
      await Promise.all(
        ['yellow', 'green'].map(async (buzzType) => {
          const userBanked = await getBanked(userId, buzzType as 'yellow' | 'green');

          if (userBanked.total > 0) {
            // Reset the banked amount by performing an extraction:

            if (userBanked.total > currentValue) {
              await createBuzzTransaction({
                amount: userBanked.total - currentValue,
                fromAccountId: 0,
                fromAccountType: 'yellow',
                toAccountId: monthAccount,
                toAccountType: 'creatorProgramBank',
                type: TransactionType.Bank,
                description: `ADMIN-FORCED-EXTRACTION: RESET BANK`,
              });

              change += userBanked.total - currentValue;
            }

            await createBuzzTransaction({
              amount: userBanked.total,
              fromAccountId: monthAccount,
              fromAccountType: 'creatorProgramBank',
              toAccountId: userId,
              toAccountType: 'yellow',
              type: TransactionType.Extract,
              description: `ADMIN-FORCED-EXTRACTION: RESET BANK`,
            });

            change -= userBanked.total;
          }
        })
      );
    }

    if (change !== 0) {
      const shouldTakeMoneyFromBank = change > 0;
      await createBuzzTransaction({
        amount: shouldTakeMoneyFromBank ? Math.min(Math.abs(change), currentValue) : change,
        fromAccountId: shouldTakeMoneyFromBank ? monthAccount : 0,
        fromAccountType: shouldTakeMoneyFromBank ? 'creatorProgramBank' : 'yellow',
        toAccountId: shouldTakeMoneyFromBank ? 0 : monthAccount,
        toAccountType: shouldTakeMoneyFromBank ? 'yellow' : 'creatorProgramBank',
        type: shouldTakeMoneyFromBank ? TransactionType.Extract : TransactionType.Bank,
        description: `ADMIN-FORCED-EXTRACTION: RESET BANK`,
      });
    }

    await bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
    await bustCompensationPoolCache();

    const updatedCompensationPool = await getCompensationPool({});
    signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CompensationPoolUpdate,
      data: updatedCompensationPool,
    });

    return res.status(200).json({
      compensationPool: updatedCompensationPool,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: 'An error occurred while resetting the bank.',
    });
  }
});
