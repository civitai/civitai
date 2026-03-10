import type { NextApiRequest, NextApiResponse } from 'next';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const version = '5.0.1466';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    // New implementation: generation-panel-specific overlay (notes optional)
    await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.CLIENT, {
      version,
      notes: 'Multi-step workflow support and improved metadata handling.',
    });

    // Legacy fallback: global modal (deprecated after rollout)
    await sysRedis.hSet(REDIS_SYS_KEYS.GENERATION.CLIENT_TEMP, { version });

    res.status(200).json({
      success: true,
      generationClientVersion: version,
    });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
