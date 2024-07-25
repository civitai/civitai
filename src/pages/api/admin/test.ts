import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server.mjs';
import { kyselyDbRead } from '~/server/kysely-db';
import { sql } from 'kysely';
import { UserRepository } from '~/server/repository/user.repository';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) return;

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

  // return res.status(200).json(items);

  // const images = await kyselyDbRead
  //   .selectFrom('Image as i')
  //   .fullJoin('Post as p', 'p.id', 'i.postId')
  //   .select(['i.id', 'p.title', 'p.id as postId', 'i.nsfwLevel'])
  //   .where((eb) => eb(eb('i.nsfwLevel', '&', 3), '!=', 0))
  //   // .where(sql`i."nsfwLevel" & 3`, '!=', 0)
  //   .limit(10)
  //   .execute();

  // const users = await userRepository.findMany(
  //   {
  //     ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  //     limit: 100,
  //   },
  //   { select: 'profileUser' }
  // );
  // const users = await userRepository.findOne(1, { select: 'profileUser' });
  // return res.status(200).send(users);

  const userSelect = kyselyDbRead.selectFrom('User').select(['id']).where('id', '=', 5);
  const userSelectWithName = userSelect.select(['name']);

  const test = await userSelect.executeTakeFirst();
  return res.status(200).send(test);

  // const posts = await kyselyDbRead.transaction().execute(async (trx) => {
  //   await kyselyDbRead.selectFrom('User').select(['id']).where('id', '=', 5).executeTakeFirst();
  //   return await kyselyDbRead.selectFrom('Post').select(['id']).where('userId', '=', 5).execute();
  // });
  // return res.status(200).send(posts);

  // return res.status(200).json(await formatTextToImageResponses(items as TextToImageResponse[]));
});
