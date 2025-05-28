import Decimal from 'decimal.js';
import { NextApiRequest, NextApiResponse } from 'next';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { searchClient } from '~/server/meilisearch/client';
import { modelsSearchIndex } from '~/server/search-index';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { sleep } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const test = await coinbaseCaller.createCharge({
    name: 'Test Charge',
    description: 'This is a test charge',
    pricing_type: 'fixed_price',
    local_price: {
      amount: new Decimal(10.0).toString(),
      currency: 'USD',
    },
  });

  res.status(200).json(test);
});
