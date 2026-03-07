import type { NextApiRequest, NextApiResponse } from 'next';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const version = process.env.version;
    if (!version) throw new Error('Could not determine current version');

    await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.CLIENT, { version });

    res.status(200).json({
      success: true,
      generationClientVersion: version,
    });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
