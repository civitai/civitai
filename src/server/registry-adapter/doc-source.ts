import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import type { DocStoreFeed } from '~/server/services/apps/doc-store';

/** A document-store registry feed (`createDocStoreFeed`), as the feed reads it. */
export function docStoreDocSource(feed: DocStoreFeed): SharedDocSource {
  return {
    head: (appId) => feed.feedHead(appId),
    changes: (appId, coll, after, upTo, limit, level) =>
      level === undefined
        ? feed.feedChanges(appId, coll, after, upTo, limit)
        : feed.feedChanges(appId, coll, after, upTo, limit, { viewerLevel: level }),
    documents: (appId, coll, afterKey, upTo, limit, level) =>
      level === undefined
        ? feed.feedDocuments(appId, coll, afterKey, upTo, limit)
        : feed.feedDocuments(appId, coll, afterKey, upTo, limit, { viewerLevel: level }),
    witness: (appId, coll, key) => feed.feedWitness(appId, coll, key),
  };
}
