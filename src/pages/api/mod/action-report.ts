import { ReportStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { bulkSetReportStatus } from '~/server/services/report.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  reportId: z.coerce.number(),
  status: z.enum(ReportStatus),
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: result.error });
  const { userId, reportId, status } = result.data;

  await bulkSetReportStatus({ ids: [reportId], status, userId, ip: '' });

  return res.status(200).json({
    reportId,
    status,
  });
});
