import type { NextApiRequest, NextApiResponse } from 'next';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import { getModeratedTags } from '~/server/services/system-cache';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { invalidateSession } from '~/server/utils/session-helpers';
import { isDefined } from '~/utils/type-guards';

type MatureContent = {
  count: number;
  subscriptions: Record<string, number>;
};

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const image = getEdgeUrl('526cbcf4-e335-415c-a4d7-f6eac7428216', { type: 'image' });
    const video = getEdgeUrl('854ea301-d377-484b-ae05-29686c2fc174', { type: 'video' });

    res.status(200).send({ image, video });
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
