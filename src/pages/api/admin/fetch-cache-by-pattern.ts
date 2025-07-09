import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { redis } from '~/server/redis/client';
import { fetchCacheByPattern } from '~/server/utils/cache-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  pattern: z.string(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { pattern } = schema.parse(req.query);
  const keys = await fetchCacheByPattern(pattern);

  return res.status(200).json({
    ok: true,
    keys,
  });
});
