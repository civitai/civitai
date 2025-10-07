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
  getPoolParticipants,
  getPoolParticipantsV2,
} from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { sleep } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const prevMonth = dayjs().subtract(1, 'month').toDate();
  const d1 = await getPoolParticipantsV2(prevMonth);
  const d2 = await getPoolParticipants(prevMonth);

  const diff = d1
    .map((item) => {
      const match = d2.find((i) => i.userId === item.userId);
      return {
        userId: item.userId,
        prev: item,
        curr: match,
      };
    })
    .filter((item) => !!item.curr);

  return res.status(200).json({
    diff,
    v2: d1,
  });
});
