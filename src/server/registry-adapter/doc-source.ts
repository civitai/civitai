import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import type { LevelDocSource } from '~/server/registry-adapter/level-feed';
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

/** A document-store registry feed's level reads (`level-feed.ts`). */
export function docStoreLevelSource(feed: DocStoreFeed): LevelDocSource {
  return {
    head: (appId) => feed.feedHead(appId),
    markHead: (appId) => feed.feedMarkHead(appId),
    changes: (appId, coll, selector, after, upTo, limit, declared) =>
      feed.levelChanges(appId, coll, selector, after, upTo, limit, declared),
    documents: (appId, coll, selector, beforeKey, upTo, limit, declared) =>
      feed.levelDocuments(appId, coll, selector, beforeKey, upTo, limit, declared),
    byKeys: (appId, coll, selector, keys, declared) =>
      feed.levelDocumentsByKeys(appId, coll, selector, keys, declared),
    tallyKeys: (appId, coll, after, upTo, limit) =>
      feed.levelTallyKeys(appId, coll, after, upTo, limit),
    witness: (appId, coll, key) => feed.feedWitness(appId, coll, key),
  };
}
