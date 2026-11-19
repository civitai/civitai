import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { searchClient } from '~/server/meilisearch/client';
import { usersSearchIndex } from '~/server/search-index';
import { refreshProfilePicturesForUsers } from '~/server/services/user.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const CHUNK = 100;

const schema = z.object({ mode: z.enum(['dry', 'run', 'verify']).default('dry') });

/** Live users whose profile picture carries a block marker, with that picture's id. */
async function markedPictureUsers() {
  return dbRead.$queryRaw<{ userId: number; pictureId: number }[]>`
    SELECT u.id AS "userId", i.id AS "pictureId"
    FROM "User" u
    JOIN "Image" i ON i.id = u."profilePictureId"
    WHERE u."deletedAt" IS NULL AND ${hasBlockMarkerSql('i')}
    ORDER BY u.id
  `;
}

/**
 * One-off, run once after the deploy in which profile pictures follow the image visibility rules:
 * copies built before it (the profile-picture cache, user search documents) can still carry a
 * picture that is no longer served.
 *
 *   GET /api/admin/temp/refresh-marked-profile-pictures?token=$WEBHOOK_TOKEN   (dry: the count)
 *   ...&mode=run      refreshes those users' pictures and queues their search documents
 *   ...&mode=verify   counts their search documents that still carry the picture
 *
 * Safe to re-run: the refresh and the search update are idempotent.
 */
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const { mode } = parsed.data;

  const rows = await markedPictureUsers();
  const userIds = rows.map((r) => r.userId);
  if (mode === 'dry') return res.status(200).json({ mode, users: userIds.length });

  if (mode === 'run') {
    let chunks = 0;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      await refreshProfilePicturesForUsers(chunk);
      await usersSearchIndex.queueUpdate(
        chunk.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
      chunks++;
    }
    logToAxiom({
      name: 'refresh-marked-profile-pictures',
      type: 'info',
      users: userIds.length,
      chunks,
    });
    return res.status(200).json({ mode, users: userIds.length, chunks });
  }

  if (!searchClient) return res.status(503).json({ error: 'search is not configured' });
  const index = searchClient.index(USERS_SEARCH_INDEX);
  let stillCarrying = 0;
  let notIndexed = 0;
  await limitConcurrency(
    rows.map(({ userId, pictureId }) => async () => {
      try {
        const doc = await index.getDocument<{ profilePicture?: { id?: number } | null }>(userId, {
          fields: ['profilePicture'],
        });
        if (doc.profilePicture?.id === pictureId) stillCarrying++;
      } catch (error) {
        if ((error as { cause?: { code?: string } })?.cause?.code === 'document_not_found')
          notIndexed++;
        else throw error;
      }
    }),
    10
  );
  return res.status(200).json({ mode, users: userIds.length, stillCarrying, notIndexed });
});
