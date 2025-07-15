import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { runPayout } from '~/server/jobs/deliver-creator-compensation';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  date: z.coerce.date(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { date } = schema.parse(req.query);
  if (date) await runPayout(date);

  return res.status(200).json({
    ok: true,
  });
});
