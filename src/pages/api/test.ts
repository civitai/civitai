import dayjs from 'dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { clickhouse } from '~/server/clickhouse/client';
import {
  createBuzzTransactionMany,
  getAccountsBalances,
  getTopContributors,
} from '~/server/services/buzz.service';
import {
  getCompensationPool,
  getMonthAccount,
  getPoolParticipants,
  getPoolParticipantsV2,
} from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { withRetries } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { id, rating = null } = req.query;
  const imageId = Number(id);

  async function test() {
    await clickhouse!.$exec`
      INSERT INTO knights_rating_updates_buffer (imageId, rating)
      VALUES (${imageId}, ${rating});
    `;
  }

  // await test();

  return res.status(200).json({
    success: true,
  });
});
