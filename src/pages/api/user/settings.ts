import { userSettingsSchema } from '~/server/schema/user.schema';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default PublicEndpoint(
  async function handler(req, res) {
    const session = await getServerAuthSession({ req, res });
    const userId = session?.user?.id;
    try {
      if (req.method === 'GET') {
        const settings = await getUserSettings(userId);
        res.status(200).json(settings);
      } else {
        if (!userId) throw new Error('must be logged in to perform this action');
        const settings = userSettingsSchema.parse(req.body);
        await setUserSetting(userId, settings);
        res.status(200).end();
      }
    } catch (e) {
      if (e instanceof Error) {
        res.status(400).json({ error: e.message });
      } else res.status(400).end();
    }
  },
  ['GET', 'POST']
);
