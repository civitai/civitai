import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '~/pages/api/auth/[...nextauth]';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';

const handler = WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);
  const writeDbCheck = await dbWrite.user
    .update({
      where: { id: -1 },
      data: { username: 'civitai' },
      select: { id: true },
    })
    .then(
      (x) => x !== null,
      () => false
    );
  const readDbCheck = await dbRead.user.findUnique({ where: { id: 1 }, select: { id: true } }).then(
    (x) => x !== null,
    () => false
  );

  // redis and session fail silently (no exception)
  const redisKey = 'system:health-check:' + podname;
  await redis.set(redisKey, 'ok');
  const redisCheck = await redis.get(redisKey);
  await redis.del(redisKey);
  const session = await getServerSession(req, res, authOptions);

  // as we're forwarding the request to authenticate with, we may not always have a server session
  // for that reason, do NOT include the server session as a factor in determining valid status
  const healthy = writeDbCheck && readDbCheck && redisCheck;

  return res.status(healthy ? 200 : 500).json({
    podname,
    healthy: healthy,
    writeDb: writeDbCheck,
    readDb: readDbCheck,
    redis: redisCheck === 'ok',
    session: session !== null,
  });
});

export default handler;
