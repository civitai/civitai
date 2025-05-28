import { ReportStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  reportId: z.coerce.number(),
  status: z.nativeEnum(ReportStatus),
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, reportId, status } = schema.parse(req.body);

  await bulkSetReportStatus({ ids: [reportId], status, userId, ip: '' });

  return res.status(200).json({
    reportId,
    status,
  });
});
