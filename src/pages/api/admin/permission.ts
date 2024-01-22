import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbWrite } from '~/server/db/client';
import { FeatureFlagKey, featureFlagKeys } from '~/server/services/feature-flags.service';
import { addSystemPermission, removeSystemPermission } from '~/server/services/system-cache';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateSession } from '~/server/utils/session-helpers';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const schema = z.object({
  key: z.string().refine((x) => featureFlagKeys.includes(x as FeatureFlagKey)),
  usernames: commaDelimitedStringArray(),
  revoke: z.coerce.boolean().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const { usernames, key, revoke } = result.data;
  const users = await dbWrite.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });

  // Add permission to users
  const userIds = users.map((x) => x.id);
  if (revoke) {
    removeSystemPermission(key as FeatureFlagKey, userIds);
  } else {
    addSystemPermission(key as FeatureFlagKey, userIds);
  }

  // Invalidate their sessions
  for (const user of users) await invalidateSession(user.id);

  return res.status(200).json({
    key,
    affected: users.length,
    userIds,
    revoke,
  });
});
