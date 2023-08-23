import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { AuthedEndpoint, PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(async function handler(req, res, user) {
  const { refresh } = req.query;
  const hiddenPreferences = await getAllHiddenForUser({
    userId: user.id ?? -1,
    refreshCache: refresh ? Boolean(refresh) : false,
  });
  res.status(200).json(hiddenPreferences);
});
