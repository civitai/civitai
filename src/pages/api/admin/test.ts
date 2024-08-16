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
import { Image } from '~/server/repository/image.repository';

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

  // const userSelect = kyselyDbRead.selectFrom('User').select(['id']).where('id', '=', 5);
  // const userSelectWithName = userSelect.select(['name']);

  // const test = await userSelect.executeTakeFirst();

  // const test = await ImageRepository.findMany({
  //   // ids: [
  //   //   220973, 1472869, 2077360, 2300644, 2929971, 3136494, 3267468, 3375895, 3660400, 3763985,
  //   //   4573494, 4647294, 4699409, 5706937, 6112572, 7161275, 7956699, 8267677, 8622519, 8841178,
  //   //   9058374, 9078035, 9087388, 9907303, 9926004, 10228662, 10263664, 10285013, 10345179, 10369117,
  //   //   10524742, 10553578, 10630176, 10736130, 10745072, 10745451, 10753103, 10833327, 10869812,
  //   //   10912274, 11052900, 11150058, 11285651, 11369485, 11369655, 11388313, 11406392, 11420596,
  //   //   11453338, 11500066, 11512908, 11544982, 11556982, 11569054, 11638873, 11654721, 11654722,
  //   //   11823765, 11940755, 11994460, 12013400, 12187342, 12195953, 12216599, 12219032, 12347785,
  //   //   12537131, 12660780, 12661077, 12661204, 12758544, 12798986, 12836522, 12885655, 12916096,
  //   //   12972013, 13029224, 13068231, 13164245, 13232440, 13255940, 13300498, 13306704, 13346140,
  //   //   13440773, 13620551, 13680657, 13760873, 13775747, 13809928, 13932463, 13948982, 13976761,
  //   //   14001739, 14031958, 14032939, 14035214, 14068710, 14125974, 14129980,
  //   // ],
  //   limit: 1000,
  // });

  const test = await UserRepository.findOneUserCreator({ id: 5 });

  return res.status(200).send(test);

  // const posts = await kyselyDbRead.transaction().execute(async (trx) => {
  //   await kyselyDbRead.selectFrom('User').select(['id']).where('id', '=', 5).executeTakeFirst();
  //   return await kyselyDbRead.selectFrom('Post').select(['id']).where('userId', '=', 5).execute();
  // });
  // return res.status(200).send(posts);

  // return res.status(200).json(await formatTextToImageResponses(items as TextToImageResponse[]));
});
