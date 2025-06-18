import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { bustCompensationPoolCache } from '~/server/services/creator-program.service';
import { getPhases } from '~/server/utils/creator-program.utils';

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const isFlipped = await sysRedis.get(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES);
  const isFlippedBool = isFlipped === 'true';
  if (isFlippedBool) {
    await sysRedis.set(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES, 'false');
  } else {
    await sysRedis.set(REDIS_SYS_KEYS.CREATOR_PROGRAM.FLIP_PHASES, 'true');
  }

  bustCompensationPoolCache();

  const phases = getPhases({ flip: !isFlippedBool });
  const currentPhase = Object.keys(phases).find((key) => {
    // @ts-ignore
    const [start, end] = phases[key];
    const now = new Date();
    return now >= start && now <= end;
  });

  return res.status(200).json({
    currentPhase,
  });
});
