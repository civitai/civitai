import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { kyselyDbRead } from '~/server/kysely-db';
import { sql } from 'kysely';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) return;

  // let token = getEncryptedCookie({ req, res }, generationServiceCookie.name);
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

  // return res.status(200).json(items);

  const images = await kyselyDbRead
    .selectFrom('Image as i')
    .fullJoin('Post as p', 'p.id', 'i.postId')
    .select(['i.id', 'p.title', 'p.id as postId', 'i.nsfwLevel'])
    .where((eb) => eb(eb('i.nsfwLevel', '&', 3), '!=', 0))
    // .where(sql`i."nsfwLevel" & 3`, '!=', 0)
    .limit(10)
    .execute();

  return res.status(200).json(images);

  // return res.status(200).json(await formatTextToImageResponses(items as TextToImageResponse[]));
});
