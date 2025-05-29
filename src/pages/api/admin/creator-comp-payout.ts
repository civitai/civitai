import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { runPayout } from '~/server/jobs/deliver-creator-compensation';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { stringDate } from '~/utils/zod-helpers';

const schema = z.object({
  date: stringDate(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { date } = schema.parse(req.query);
  if (date) await runPayout(date);

  return res.status(200).json({
    ok: true,
  });
});
