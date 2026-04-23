import * as z from 'zod';
import { civTokenEncrypt } from '~/server/auth/civ-token';
import { readOgModCookie, setOgModCookie } from '~/server/auth/og-mod-cookie';
import { getSessionUser } from '~/server/auth/session-user';
import { dbRead } from '~/server/db/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  // The effective moderator may come from the current session OR from a signed
  // og-mod cookie when the session is already impersonating a non-mod user.
  let effectiveMod = user;
  let features = getFeatureFlags({ user, req });
  if (!features.impersonation) {
    const ogUserId = readOgModCookie(req);
    if (ogUserId && ogUserId !== user.id) {
      const ogUser = await getSessionUser({ userId: ogUserId });
      if (ogUser) {
        const ogFeatures = getFeatureFlags({ user: ogUser, req });
        if (ogFeatures.impersonation) {
          effectiveMod = ogUser;
          features = ogFeatures;
        }
      }
    }
  }

  if (!features.impersonation) return res.status(401).send('Unauthorized');

  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).send(result.error.message);

  const { userId } = result.data;
  if (userId === effectiveMod.id) return res.status(400).send('Cannot switch to same user');

  const switchToUser = await dbRead.user.findFirst({
    where: { id: userId },
    select: { id: true },
  });
  if (!switchToUser) {
    return res.status(404).send(`No user found with ID: ${userId}`);
  }

  try {
    const token = civTokenEncrypt(userId.toString());

    // Pin the og-mod cookie to the real moderator so chained impersonations keep
    // the original mod as the restore point.
    setOgModCookie(res, effectiveMod.id);

    await trackModActivity(effectiveMod.id, {
      entityType: 'impersonate',
      entityId: userId,
      activity: 'on',
    });

    return res.status(200).json({ token });
  } catch (error: unknown) {
    return res.status(500).send((error as Error).message);
  }
});
