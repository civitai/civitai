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
  let cleared = 0;
  const clearedKeys: string[] = [];
  let noNewKeysOccurances = 0;
  while (cursor !== 0) {
    const reply = await redis.scan(cursor ?? 0, {
      MATCH: pattern,
      COUNT: 10000000,
    });

    cursor = reply.cursor;

    const keys = reply.keys;
    const newKeys = keys.filter((key) => !clearedKeys.includes(key));
    clearedKeys.push(...newKeys);
    cleared += newKeys.length;

    // Delete the keys found (if any)
    if (newKeys.length > 0) await redis.del(newKeys);
    else {
      noNewKeysOccurances++;
      if (noNewKeysOccurances > 10) break;
    }
    console.log(
      'cleared:',
      cleared,
      'new:',
      newKeys.length,
      'noNewKeysOccurances:',
      noNewKeysOccurances
    );
  }

  return res.status(200).json({
    ok: true,
    cleared: cleared,
  });
});
