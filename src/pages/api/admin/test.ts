import type { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import { getModeratedTags } from '~/server/services/system-cache';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { invalidateSession } from '~/server/auth/session-invalidation';
import { decreaseDate } from '~/utils/date-helpers';
import { isDefined } from '~/utils/type-guards';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';

type MatureContent = {
  count: number;
  subscriptions: Record<string, number>;
};

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 6;

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const workflow = await createImageIngestionRequest({
      imageId: 117366427,
      url: '456b830f-1d62-4530-8d30-792010004b99',
      type: 'image',
    });

    res.status(200).send({ workflow });
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});

/*
August
Total new users - 346617
Total new users with mature content disabled - 193086
Total new users with mature content enabled - 153531

Total active users with mature content disabled - 235435
Total active users with mature content enabled - 585806

*/
