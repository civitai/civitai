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

type MatureContent = {
  count: number;
  subscriptions: Record<string, number>;
};

const IMAGE_SCANNING_ERROR_DELAY = 60 * 1; // 1 hour
const IMAGE_SCANNING_RETRY_LIMIT = 6;

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const now = new Date();
    const errorRetryDate = decreaseDate(now, IMAGE_SCANNING_ERROR_DELAY, 'minutes').getTime();
    const errorImages = (
      (await dbWrite.$queryRaw<any[]>`
       SELECT id, url, type, width, height, meta->>'prompt' as prompt, "scanRequestedAt", ("scanJobs"->>'retryCount')::int as "retryCount"
       FROM "Image"
       WHERE ingestion = 'Error'::"ImageIngestionStatus" AND ("createdAt" > now() - '6 hours'::interval OR ("nsfwLevel" IS NOT NULL AND "createdAt" > '10/15/2025'))
     `) ?? []
    ).filter((img) => {
      console.log(Number(img.retryCount ?? 0));
      return (
        img.scanRequestedAt &&
        new Date(img.scanRequestedAt).getTime() <= errorRetryDate &&
        Number(img.retryCount ?? 0) < IMAGE_SCANNING_RETRY_LIMIT
      );
    });

    res.status(200).send({ errorImages });
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
