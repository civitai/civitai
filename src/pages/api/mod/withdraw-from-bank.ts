import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getMonthAccount } from '~/server/services/creator-program.service';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

const schema = z.object({
  amount: z.coerce.number(),
  userId: z.coerce.number().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const monthAccount = getMonthAccount();
  const { userId, amount } = schema.parse(req.body);

  try {
    const { transactionId } = await createBuzzTransaction({
      fromAccountId: monthAccount,
      fromAccountType: 'creatorProgramBank',
      toAccountId: userId ?? -1,
      toAccountType: 'yellow',
      amount,
      type: TransactionType.Withdrawal,
      description: `ADMIN WITHDRAWAL FROM BANK.`,
    });

    return res.status(200).json({
      transactionId,
      amount,
    });
  } catch (error) {
    return res.status(500).json({
      error,
    });
  }
});
