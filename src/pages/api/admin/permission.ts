import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { featureFlagKeys } from '~/server/services/feature-flags.service';
import { addSystemPermission, removeSystemPermission } from '~/server/services/system-cache';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { refreshSession } from '~/server/auth/session-invalidation';
import { booleanString, commaDelimitedStringArray } from '~/utils/zod-helpers';

export const schema = z.object({
  // Accepts a single key or a comma-delimited list (e.g. key=a,b,c).
  key: commaDelimitedStringArray(),
  usernames: commaDelimitedStringArray(),
  // booleanString, not z.coerce.boolean: this schema is parsed against req.query, where
  // coerce runs JS Boolean() and makes `?revoke=false` TRUE — taking the REMOVE branch and
  // invalidating each affected user's session.
  revoke: booleanString().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const { usernames, key, revoke } = result.data;

  // Keep only valid feature flag keys; silently skip the rest.
  const keys = key.filter((x): x is FeatureFlagKey =>
    featureFlagKeys.includes(x as FeatureFlagKey)
  );
  const skipped = key.filter((x) => !featureFlagKeys.includes(x as FeatureFlagKey));

  const users = await dbWrite.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });

  // Add/remove each valid permission for the matched users.
  // MUST run sequentially with await: addSystemPermission/removeSystemPermission
  // each read-modify-write the *entire* system:permissions blob, so firing them
  // concurrently (or not awaiting at all) makes them clobber each other —
  // last-write-wins drops every mutation but one, and in a serverless route the
  // response can return before unawaited writes settle.
  const userIds = users.map((x) => x.id);
  for (const k of keys) {
    if (revoke) {
      await removeSystemPermission(k, userIds);
    } else {
      await addSystemPermission(k, userIds);
    }
  }

  // Invalidate their sessions
  for (const user of users) await refreshSession(user.id, { caller: 'admin' });

  return res.status(200).json({
    keys,
    skipped,
    affected: users.length,
    userIds,
    revoke,
  });
});
