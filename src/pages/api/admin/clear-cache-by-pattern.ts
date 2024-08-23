import { chunk } from 'lodash-es';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  pattern: z.string(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { pattern } = schema.parse(req.query);
  let cursor: number | undefined;
  let cleared: string[] = [];
  while (cursor !== 0) {
    console.log('Scanning:', cursor);
    const reply = await redis.scan(cursor ?? 0, {
      MATCH: pattern,
      COUNT: 10000000,
    });

    cursor = reply.cursor;
    const keys = reply.keys;
    const newKeys = keys.filter((key) => !cleared.includes(key));
    console.log('Total keys:', cleared.length, 'Adding:', newKeys.length, 'Cursor:', cursor);
    if (newKeys.length === 0) continue;

    const batches = chunk(newKeys, 10000);
    for (let i = 0; i < batches.length; i++) {
      console.log('Clearing:', i, 'Of', batches.length);
      await redis.del(batches[i]);
      cleared.push(...batches[i]);
      console.log('Cleared:', i, 'Of', batches.length);
    }
    console.log('Cleared:', cleared.length);
    console.log('Cursor:', cursor);
  }
  console.log('Done');

  return res.status(200).json({
    ok: true,
    cleared: cleared.length,
  });
});
