import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { createAuthOptions } from '~/pages/api/auth/[...nextauth]';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const handler = WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
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

  // redis and session fail silenty (no exception)
  const redisCheck = await redis.get('user:-1:hidden-tags');
  const session = await getServerSession(req, res, createAuthOptions(req));

  // as we're forwarding the request to authenticate with, we may not always have a server session
  // for that reason, do NOT include the server session as a factor in determining valid status
  const healthy = writeDbCheck && readDbCheck && redisCheck;

  return res.status(healthy ? 200 : 500).json({
    podname: process.env.PODNAME,
    healthy: healthy,
    writeDb: writeDbCheck,
    readDb: readDbCheck,
    redis: redisCheck !== null,
    session: session !== null,
  });
});

export default handler;
