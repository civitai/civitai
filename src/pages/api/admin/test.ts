import { ImageIngestionStatus } from '@prisma/client';
import dayjs from 'dayjs';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { getTopContributors } from '~/server/services/buzz.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { signalClient } from '~/utils/signal-client';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // const teamAccounts = eventEngine.getTeamAccounts('holiday2023');
  // const accountIds = Object.values(teamAccounts);
  // const start = dayjs().subtract(1, 'day').toDate();
  // const dayContributorsByAccount = await getTopContributors({ accountIds, limit: 500, start });
  // return res.send(dayContributorsByAccount);

  // await eventEngine.processEngagement({
  //   entityType: 'model',
  //   type: 'published',
  //   entityId: 218322,
  //   userId: 969069,
  // });
  signalClient.send({
    target: 'image-ingestion:status',
    data: { imageId: 175719, ingestion: ImageIngestionStatus.Blocked, blockedFor: 'being rude' },
    userId: 5,
  });

  return res.status(200).json({
    ok: true,
  });
});
