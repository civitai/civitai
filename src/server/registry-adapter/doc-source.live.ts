import type { SharedDocSource } from '~/server/registry-adapter/doc-feed';
import { docStoreDocSource } from '~/server/registry-adapter/doc-source';
import { getDocStoreFeed } from '~/server/services/apps/doc-store-feed.instance';

/** The process's document-store registry feed, as the feed reads it. */
export function liveSharedDocSource(): SharedDocSource {
  return docStoreDocSource(getDocStoreFeed());
}
