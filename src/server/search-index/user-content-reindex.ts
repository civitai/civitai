import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
} from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';

const OWNED_CONTENT_QUEUE_CHUNK = 1000;

type OwnedContentIndex = {
  indexName: string;
  ownedIds: (userId: number) => Promise<{ id: number }[]>;
};

// Every live index whose documents embed the owner's `user.username`, which they match and filter
// on. `images_v6` and `metrics_images_v1` also embed it but are retired, so they are not listed.
// Queued through `SearchIndexUpdate` rather than the processors: importing those from here closes
// an import cycle back through `user.service`.
const OWNED_CONTENT_INDEXES: OwnedContentIndex[] = [
  {
    indexName: MODELS_SEARCH_INDEX,
    ownedIds: (userId) => dbRead.model.findMany({ where: { userId }, select: { id: true } }),
  },
  {
    indexName: ARTICLES_SEARCH_INDEX,
    ownedIds: (userId) => dbRead.article.findMany({ where: { userId }, select: { id: true } }),
  },
  {
    indexName: COLLECTIONS_SEARCH_INDEX,
    ownedIds: (userId) => dbRead.collection.findMany({ where: { userId }, select: { id: true } }),
  },
  {
    indexName: BOUNTIES_SEARCH_INDEX,
    ownedIds: (userId) => dbRead.bounty.findMany({ where: { userId }, select: { id: true } }),
  },
  {
    indexName: COMICS_SEARCH_INDEX,
    ownedIds: (userId) => dbRead.comicProject.findMany({ where: { userId }, select: { id: true } }),
  },
];

/**
 * Queues every content document a user owns for a rebuild, so a rename reaches them. Each
 * document carries the owner's username, which search filters and matches on inside Meilisearch,
 * and nothing else revisits an existing document when its owner changes.
 *
 * A rebuild rather than a patch of the `user` field: Meilisearch merges updates at the top level
 * only, so a patch has to resend the whole `user` object, and each index builds it differently.
 * The queued ids go through the same `transformData` as any other edit, so they cannot drift.
 * Ids the index does not hold (drafts, private collections) produce no document, as they would
 * on any other enqueue.
 *
 * Call after the rename has committed. Failures are logged per index and swallowed: the rename
 * already happened, and a stale document is the smaller failure.
 */
export async function queueOwnedContentUpdate(userId: number) {
  await Promise.all(
    OWNED_CONTENT_INDEXES.map(async ({ indexName, ownedIds }) => {
      try {
        const ids = (await ownedIds(userId)).map(({ id }) => id);
        for (let i = 0; i < ids.length; i += OWNED_CONTENT_QUEUE_CHUNK) {
          await SearchIndexUpdate.queueUpdate({
            indexName,
            items: ids
              .slice(i, i + OWNED_CONTENT_QUEUE_CHUNK)
              .map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
          });
        }
      } catch (error) {
        await logToAxiom({
          type: 'error',
          name: 'owned-content-search-index',
          message: (error as Error).message,
          indexName,
          userId,
        }).catch(() => undefined);
      }
    })
  );
}
