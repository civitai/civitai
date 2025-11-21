import dayjs from 'dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
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
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { withRetries } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { workflowId } = req.query;

  async function test() {
    const workflow = await getWorkflow({
      token: env.ORCHESTRATOR_ACCESS_TOKEN,
      path: { workflowId: workflowId as string },
    });

    console.dir({ workflow }, { depth: null });
  }

  // await test();

  return res.status(200).json({
    success: true,
  });
});
