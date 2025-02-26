import { getUserSettings } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default PublicEndpoint(
  async function handler(req, res) {
    const session = await getServerAuthSession({ req, res });
    const settings = await getUserSettings(session?.user?.id ?? -1);
    res.status(200).json(settings);
  },
  ['GET']
);
