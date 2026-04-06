import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) return;

  let token = getEncryptedCookie({ req, res }, generationServiceCookie.name);
  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId: user.id,
    });
    setEncryptedCookie(
      { req, res },
      {
        name: generationServiceCookie.name,
        maxAge: generationServiceCookie.maxAge,
        value: token,
      }
    );
  }

  const { nextCursor, items } = await queryWorkflows({
    token,
    take: 1000,
    tags: [],
    hideMatureContent: false,
  });

  return res.status(200).json(items);
});
