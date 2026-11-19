import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  countSearchDocsStillCarrying,
  markedPictureUsers,
  refreshMarkedPictureUsers,
} from '~/server/services/refresh-marked-profile-pictures';
import { usersSearchIndex } from '~/server/search-index';
import { refreshProfilePicturesForUsers } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  mode: z.enum(['dry', 'run', 'verify']).default('dry'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

/**
 * One-off, run once after the deploy in which profile pictures follow the image visibility rules:
 * copies built before it (the profile-picture cache, user search documents) can still carry a
 * picture that is no longer served. Responses and logs carry counts only.
 *
 *   GET /api/admin/temp/refresh-marked-profile-pictures?token=$WEBHOOK_TOKEN   (dry: the count)
 *   POST ...&mode=run   refreshes up to `limit` (1000) of those users and queues their search
 *                       documents from `offset`; the response's `next` is the next call's offset
 *   ...&mode=verify   once the search-index queue has drained: their documents still carrying it
 *
 * Safe to re-run: the refresh and the search update are idempotent.
 */
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const { mode, offset, limit } = parsed.data;
  if (mode === 'run' && req.method !== 'POST')
    return res.status(405).json({ error: 'mode=run needs POST' });

  const rows = await markedPictureUsers();
  if (mode === 'dry') return res.status(200).json({ mode, users: rows.length });

  if (mode === 'run') {
    // Ordered by user id, and a refresh leaves the selection as it was, so offsets are stable.
    const batch = rows.slice(offset, offset + limit);
    const result = await refreshMarkedPictureUsers(
      batch.map((r) => r.userId),
      {
        refresh: refreshProfilePicturesForUsers,
        queue: (items) => usersSearchIndex.queueUpdate(items),
      }
    );
    const next = offset + batch.length < rows.length ? offset + batch.length : null;
    return res
      .status(200)
      .json({ mode, users: rows.length, refreshed: batch.length, next, ...result });
  }

  return res
    .status(200)
    .json({ mode, users: rows.length, ...(await countSearchDocsStillCarrying(rows)) });
});
