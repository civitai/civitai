import type { NextApiRequest, NextApiResponse } from 'next';
import { userContentOverviewCache } from '~/server/redis/caches';
import { dbRead } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const user = await dbRead.user.findUnique({
      where: { username: 'theally' },
      select: { id: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    await userContentOverviewCache.refresh(user.id);
    res.status(200).json({ message: `Refreshed content overview cache for user ${user.id}` });
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
