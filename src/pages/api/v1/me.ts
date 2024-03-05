import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';

import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) {
  res.send({
    id: user.id,
    username: user.username,
    tier: user.tier,
    status: user.bannedAt ? 'banned' : user.muted ? 'muted' : 'active',
  });
});
