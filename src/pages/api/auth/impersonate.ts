import { z } from 'zod';
import { civTokenEncrypt } from '~/pages/api/auth/civ-token';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const features = getFeatureFlags({ user });
  if (!features || !features.impersonation) return res.status(401).send('Unauthorized');

  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).send(result.error.message);

  const { userId } = result.data;
  if (userId === user.id) return res.status(400).send('Cannot switch to same user');

  const switchToUser = await dbRead.user.findFirst({
    where: { id: userId },
    select: { id: true },
  });
  if (!switchToUser) {
    return res.status(404).send(`No user found with ID: ${userId}`);
  }

  try {
    const token = civTokenEncrypt(userId.toString());

    await trackModActivity(user.id, {
      entityType: 'impersonate',
      entityId: userId,
      activity: 'on',
    });

    return res.status(200).json({ token });
  } catch (error: unknown) {
    return res.status(500).send((error as Error).message);
  }
});
