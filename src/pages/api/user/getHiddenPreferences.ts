import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default PublicEndpoint(async function handler(req, res) {
  const { refresh } = req.query;
  console.time('get session');
  console.time('total fetch time');
  const session = await getServerAuthSession({ req, res });
  console.timeEnd('get session');
  const hiddenPreferences = await getAllHiddenForUser({
    userId: session?.user?.id ?? -1,
    refreshCache: refresh ? Boolean(refresh) : false,
  });
  console.timeEnd('total fetch time');
  res.status(200).json(hiddenPreferences);
});
