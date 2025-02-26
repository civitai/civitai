import { ReportStatus } from '~/shared/utils/prisma/enums';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  bustCompensationPoolCache,
  getBanked,
  getCompensationPool,
  getMonthAccount,
} from '~/server/services/creator-program.service';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { sleep } from '~/server/utils/concurrency-helpers';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';

const schema = z.object({
  userId: z.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  // USE WITH THE UTMOST CARE PLEASE <3. NEVER RUN WITHOUT CONSULTING A DEV
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

  bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  bustCompensationPoolCache();

  const compensationPool = await getCompensationPool({});

  const currentValue = compensationPool.size.current;
  let change = -currentValue;
  const monthAccount = getMonthAccount();

  if (userId) {
    // Get user's current balance
    const userBanked = await getBanked(userId);
    // Reset the banked amount by performing an extraction:
    await createBuzzTransaction({
      amount: userBanked.total,
      fromAccountId: monthAccount,
      fromAccountType: 'creatorprogrambank',
      toAccountId: userId,
      toAccountType: 'user',
      type: TransactionType.Extract,
      description: `ADMIN-FORCED-EXTRACTION: RESET BANK`,
    });

    change += userBanked.total;
  }

  if (change !== 0) {
    const shouldTakeMoneyFromBank = change < 0;
    await createBuzzTransaction({
      amount: change,
      fromAccountId: shouldTakeMoneyFromBank ? monthAccount : 0,
      fromAccountType: shouldTakeMoneyFromBank ? 'creatorprogrambank' : 'user',
      toAccountId: shouldTakeMoneyFromBank ? 0 : monthAccount,
      toAccountType: shouldTakeMoneyFromBank ? 'user' : 'creatorprogrambank',
      type: shouldTakeMoneyFromBank ? TransactionType.Extract : TransactionType.Bank,
      description: `ADMIN-FORCED-EXTRACTION: RESET BANK`,
    });
  }

  await sleep(1000);

  bustFetchThroughCache(`${REDIS_KEYS.CREATOR_PROGRAM.BANKED}:${userId}`);
  bustCompensationPoolCache();

  const updatedCompensationPool = await getCompensationPool({});
  await signalClient.topicSend({
    topic: SignalTopic.CreatorProgram,
    target: SignalMessages.CompensationPoolUpdate,
    data: updatedCompensationPool,
  });

  return res.status(200).json({
    compensationPool: updatedCompensationPool,
  });
});
