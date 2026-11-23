import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import { docStoreDocSource, docStoreLevelSource } from '~/server/registry-adapter/doc-source';
import type { LevelDocSource } from '~/server/registry-adapter/level-feed';
import { getDocStoreFeed } from '~/server/services/apps/doc-store-feed.instance';

/** The process's document-store registry feed, as the feed reads it. */
export function liveSharedDocSource(): SharedDocSource {
  return docStoreDocSource(getDocStoreFeed());
}

/** The process's document-store registry feed, as the level streams read it. */
export function liveLevelDocSource(): LevelDocSource {
  return docStoreLevelSource(getDocStoreFeed());
}
