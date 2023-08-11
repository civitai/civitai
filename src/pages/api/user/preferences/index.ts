import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { AuthedEndpoint, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default PublicEndpoint(
  async function handler(req, res) {
    const session = await getServerAuthSession({ req, res });
    const userId = session?.user?.id ?? -1;
    const { refreshCache } = req.query;

    const data = await getAllHiddenForUser({
      userId,
      refreshCache: refreshCache ? Boolean(refreshCache) : undefined,
    });
    return res.status(200).json(data);

    // switch (req.method) {
    //   case 'GET':
    //     const data =  await getAllHiddenForUser({ userId });
    //     return res.send(200).json(data)

    // }

    // res.status(200);
  },
  ['GET']
);
