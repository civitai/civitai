import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { runLicenseFeePayout } from '~/server/jobs/deliver-license-fees';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  date: z.coerce.date(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { date } = schema.parse(req.query);
  if (date) await runLicenseFeePayout(date);

  return res.status(200).json({
    ok: true,
  });
});
