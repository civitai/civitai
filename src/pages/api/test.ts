import dayjs from 'dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createBuzzTransactionMany, getAccountsBalances } from '~/server/services/buzz.service';
import {
  getCompensationPool,
  getPoolParticipants,
  getPoolParticipantsV2,
} from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { withRetries } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const month = dayjs().subtract(1, 'months').toDate();
  const participants = await getPoolParticipantsV2(month, true, 'yellow');
  const balances = await getAccountsBalances({
    accountIds: participants.map((p) => p.userId),
    accountTypes: ['cashsettled'],
  });

  return res.status(200).json({
    month,
    balances,
    participants,
  });
});
