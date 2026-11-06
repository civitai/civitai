import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import { getDocStoreFeed } from '~/server/services/apps/doc-store-feed.instance';

/** The document store's registry feed, as the feed reads it. */
export function liveSharedDocSource(): SharedDocSource {
  const feed = getDocStoreFeed();
  return {
    head: (appId) => feed.feedHead(appId),
    changes: (appId, coll, after, upTo, limit) => feed.feedChanges(appId, coll, after, upTo, limit),
    documents: (appId, coll, afterKey, upTo, limit) =>
      feed.feedDocuments(appId, coll, afterKey, upTo, limit),
    witness: (appId, coll, key) => feed.feedWitness(appId, coll, key),
  };
}
