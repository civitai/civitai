/**
 * The private feed's live dependencies (`private-feed.ts`): the document store's private reads and
 * THE collection-read predicate, `decideCollectionRead` (`data-read-grant.ts`), never a copy of it.
 * Imported only by `main.ts`, and called only while `REGISTRY_ADAPTER_PRIVATE_RELAYS` is set.
 */
import type {
  DecideCollectionRead,
  PrivateDocSource,
} from '~/server/registry-adapter/private-feed';
import { decideCollectionRead } from '~/server/services/apps/data-read-grant';
import { getDocStorePrivateFeed } from '~/server/services/apps/doc-store-private-feed.instance';

export function livePrivateDocSource(): PrivateDocSource {
  const feed = getDocStorePrivateFeed();
  return {
    versions: (appId, coll, userId, afterKey, limit) =>
      feed.privateVersions(appId, coll, userId, afterKey, limit),
    documents: (appId, coll, userId, afterKey, limit) =>
      feed.privateDocuments(appId, coll, userId, afterKey, limit),
  };
}

export const liveDecideCollectionRead: DecideCollectionRead = (reader, target) =>
  decideCollectionRead(reader, target);
