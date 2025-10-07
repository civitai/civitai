import dayjs from 'dayjs';
import Decimal from 'decimal.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { searchClient } from '~/server/meilisearch/client';
import { modelsSearchIndex } from '~/server/search-index';
import {
  getCompensationPool,
  getPoolParticipants,
  getPoolParticipantsV2,
} from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { sleep } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const prevMonth = dayjs().subtract(1, 'month').toDate();
  const pool = await getCompensationPool({ month: prevMonth });
  const v2 = await getPoolParticipantsV2(prevMonth);
  const v1 = await getPoolParticipants(prevMonth);

  const diff = v2
    .map((item) => {
      const match = v1.find((i) => i.userId === item.userId);
      return {
        userId: item.userId,
        data: item,
        match,
      };
    })
    .filter((item) => !item.match);

  const allocations: [number, number][] = [];
  let availablePoolValue = Math.floor(pool.value * 100);
  for (const participant of v2) {
    // If we're out of pool value, we're done... (sorry folks)
    if (availablePoolValue <= 0) break;

    // Determine participant share
    const participantPortion = participant.amount / pool.size.current;
    let participantShare = Math.floor(pool.value * participantPortion * 100);
    const perBuzzValue = participantShare / participant.amount;
    // Cap Buzz value
    if (perBuzzValue > CAPPED_BUZZ_VALUE) participantShare = participant.amount * CAPPED_BUZZ_VALUE;

    // Set allocation
    if (diff.find((d) => d.userId === participant.userId)) {
      allocations.push([participant.userId, participantShare]);
    }

    availablePoolValue -= participantShare;
  }

  return res.status(200).json({
    allocations,
  });
});
