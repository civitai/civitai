import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server.mjs';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  console.log('hit me');
  // const session = await getServerAuthSession({ req, res });
  // const user = session?.user;
  // if (!user) return;

  // let token = getEncryptedCookie({ req, res }, generationServiceCookie.name);
  // if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  // if (!token) {
  //   token = await getTemporaryUserApiKey({
  //     name: generationServiceCookie.name,
  //     // make the db token live just slightly longer than the cookie token
  //     maxAge: generationServiceCookie.maxAge + 5,
  //     scope: ['Generate'],
  //     type: 'System',
  //     userId: user.id,
  //   });
  //   setEncryptedCookie(
  //     { req, res },
  //     {
  //       name: generationServiceCookie.name,
  //       maxAge: generationServiceCookie.maxAge,
  //       value: token,
  //     }
  //   );
  // }

  // const { nextCursor, items } = await queryWorkflows({
  //   token,
  //   take: 10,
  //   tags: ['civitai', 'img'],
  // });

  return res.status(200).json({ ok: true });
  // return res.status(200).json(await formatTextToImageResponses(items as TextToImageResponse[]));
});
