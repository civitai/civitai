import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const configSchema = z.object({
  perMinute: z.number().int().min(1).optional(),
  perHour: z.number().int().min(1).optional(),
  perDay: z.number().int().min(1).optional(),
  abuseThreshold: z.number().int().min(1).optional(),
});

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const key = REDIS_SYS_KEYS.NEW_ORDER.CONFIG;

    if (req.method === 'GET') {
      const config = await sysRedis.packed.get(key);
      return res.status(200).json({ config: config ?? null });
    }

    // PUT — update config
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid config', details: parsed.error.format() });
    }

    // Merge with existing config so partial updates work
    const existing = (await sysRedis.packed.get(key)) ?? {};
    const merged = { ...existing, ...parsed.data };

    await sysRedis.packed.set(key, merged);

    return res.status(200).json({ config: merged });
  },
  ['GET', 'PUT']
);
