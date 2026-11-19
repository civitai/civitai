import { USERS_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { searchClient } from '~/server/meilisearch/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const REFRESH_CHUNK = 100;

// Block markers only: a picture under an owner-hidden hold was already left out before.
export async function markedPictureUsers() {
  return dbRead.$queryRaw<{ userId: number; pictureId: number }[]>`
    SELECT u.id AS "userId", i.id AS "pictureId"
    FROM "User" u
    JOIN "Image" i ON i.id = u."profilePictureId"
    WHERE u."deletedAt" IS NULL AND ${hasBlockMarkerSql('i')}
    ORDER BY u.id
  `;
}

/**
 * Refreshes the users' profile pictures and queues their search documents, a chunk at a time. The
 * refresh never throws (it logs its own failures), so verify is what shows a run worked.
 */
export async function refreshMarkedPictureUsers(
  userIds: number[],
  deps: {
    refresh: (userIds: number[]) => Promise<unknown>;
    queue: (items: { id: number; action: SearchIndexUpdateQueueAction }[]) => Promise<unknown>;
  }
) {
  let chunks = 0;
  for (let i = 0; i < userIds.length; i += REFRESH_CHUNK) {
    const chunk = userIds.slice(i, i + REFRESH_CHUNK);
    await deps.refresh(chunk);
    await deps.queue(chunk.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })));
    chunks++;
    logToAxiom({
      name: 'refresh-marked-profile-pictures',
      type: 'info',
      message: 'chunk refreshed',
      payload: { chunk: chunks, users: chunk.length },
    });
  }
  return { chunks };
}

const isMissingDocument = (error: unknown) => {
  const e = error as { code?: string; httpStatus?: number };
  return e?.code === 'document_not_found' || e?.httpStatus === 404;
};

/**
 * Of these users, how many search documents still carry the marked picture. Read once the
 * search-index update queue has drained: before that, the documents are the old ones.
 */
export async function countSearchDocsStillCarrying(rows: { userId: number; pictureId: number }[]) {
  if (!searchClient) throw new Error('search is not configured');
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
        if (isMissingDocument(error)) notIndexed++;
        else throw error;
      }
    }),
    10
  );
  return { stillCarrying, notIndexed };
}
