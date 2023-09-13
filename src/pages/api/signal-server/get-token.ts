import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { getAccessToken } from '~/server/services/signals.service';

export default AuthedEndpoint(async function handler(req, res, user) {
  try {
    const { accessToken } = await getAccessToken({ id: user.id });
    res.status(200).send(accessToken);
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
