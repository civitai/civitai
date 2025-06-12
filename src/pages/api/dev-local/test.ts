import dayjs from 'dayjs';
import Decimal from 'decimal.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { searchClient } from '~/server/meilisearch/client';
import { modelsSearchIndex } from '~/server/search-index';
import { getCompensationPool } from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { sleep } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const pool = await getCompensationPool({
    month: dayjs().add(1, 'month').startOf('month').toDate(),
  });

  res.status(200).json(pool);
});
