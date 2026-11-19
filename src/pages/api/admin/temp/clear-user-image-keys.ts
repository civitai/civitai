import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { userBasicCache } from '~/server/redis/caches';
import { usersSearchIndex } from '~/server/search-index';
import { clearUserImageKeys, userImageKeyPlan } from '~/server/services/held-image-keys';
import { refreshProfilePicturesForUsers } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  mode: z.enum(['dry', 'run', 'verify']).default('dry'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

/**
 * One-off, run once after the deploy in which `User.image` stops receiving upload keys: empties the
 * ones written before it. A user with no profile picture whose key names an own image that can be a
 * picture gets that image as their picture instead.
 *
 *   GET /api/admin/temp/clear-user-image-keys?token=$WEBHOOK_TOKEN   (dry: counts, from the replica)
 *   POST ...&mode=run      empties them on the primary and refreshes those users' basic-user cache
 *                          entry, search document, picture cache and sessions. The response carries
 *                          the previous values, the only copy of them: keep it privately.
 *   ...&mode=verify        how many remain (replica)
 *
 * Safe to re-run: a second run finds nothing to change.
 */
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const { mode, limit } = parsed.data;
  if (mode === 'run' && req.method !== 'POST')
    return res.status(405).json({ error: 'mode=run needs POST' });

  if (mode !== 'run') {
    const rows = await userImageKeyPlan(dbRead, limit);
    if (mode === 'verify') return res.status(200).json({ mode, remaining: rows.length });
    return res.status(200).json({
      mode,
      users: rows.length,
      withPicture: rows.filter((row) => row.hasPicture).length,
      move: rows.filter((row) => !row.hasPicture && row.movableImageId !== null).length,
      keyImageQueued: rows.filter((row) => row.keyImageQueued).length,
    });
  }

  const planned = await userImageKeyPlan(dbWrite, limit);
  const cleared = await clearUserImageKeys(
    dbWrite,
    planned.map((row) => row.id)
  );
  const ids = cleared.map((row) => row.id);
  if (ids.length) {
    await userBasicCache.refresh(ids);
    await usersSearchIndex.queueUpdate(
      ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
    await refreshProfilePicturesForUsers(ids);
  }
  return res.status(200).json({
    mode,
    cleared: cleared.length,
    moved: cleared.filter((row) => row.pictureId !== row.previousPictureId).length,
    previous: cleared,
  });
});
