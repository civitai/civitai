import dayjs from 'dayjs';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { getTopContributors } from '~/server/services/buzz.service';
import {
  createCsamReport,
  getCsamsToReport,
  processCsamReport,
} from '~/server/services/csam.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const userId = 242370;

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // const images = await dbRead.image.findMany({ where: { userId } });
  // await createCsamReport({
  //   userId,
  //   reportedById: 5,
  //   origin: 'user',
  //   minorDepiction: 'non-real',
  //   contents: ['nonRealMinors'],
  //   images: images.map(({ id }) => ({ id, fileAnnotations: { generativeAi: true } })),
  // });

  const reports = await getCsamsToReport();

  if (reports.length) await processCsamReport(reports[0]);
  // return res.send(result);

  // const status = await ncmecCaller.getStatus();
  // return res.status(200).json(status);
  // await zipAndUploadCsamImages({ userId: 5 });
  // const ips = await getUserIpInfo({ userId: 5418 });
  // console.log(ips);
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

  return res.status(200).json({
    ok: true,
  });
});
