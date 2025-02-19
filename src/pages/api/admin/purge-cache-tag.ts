import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  tag: z.string(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { tag } = schema.parse(req.query);
  await redis.purgeTags(tag);

  return res.status(200).json({
    ok: true,
  });
});
