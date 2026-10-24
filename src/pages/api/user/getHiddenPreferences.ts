import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

export default PublicEndpoint(async function handler(req, res) {
  const { refresh } = req.query;
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  const hiddenPreferences = await getAllHiddenForUser({
    userId: userId ?? -1,
    // A refresh rebuilds every cache from the database (the block caches from the primary), so
    // only a signed-in user may ask for one, for their own preferences. Anonymous callers get the
    // cached shared answer.
    refreshCache: userId ? Boolean(refresh) : false,
  });
  res.status(200).json(hiddenPreferences);
});
