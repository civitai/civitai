/**
 * The private feed's live dependencies (`private-feed.ts`): the document store's private reads and
 * THE collection-read predicate, `decideCollectionRead` (`data-read-grant.ts`), never a copy of it.
 * Imported only by `main.ts`, and called only while `REGISTRY_ADAPTER_PRIVATE_RELAYS` is set.
 */
import type {
  DecideCollectionRead,
  PrivateDocSource,
  PrivateFeedOptions,
} from '~/server/registry-adapter/private-feed';
import { sessionClient } from '~/server/auth/session-client';
import { readAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { decideCollectionRead } from '~/server/services/apps/data-read-grant';
import { getDocStorePrivateFeed } from '~/server/services/apps/doc-store-private-feed.instance';
import type { SessionUser } from '~/types/session';

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

/**
 * Whether the run gate's flag can be read for `userId` (`readAppBlocksEnabled`). A user who no
 * longer resolves is a real refusal, so it counts as readable.
 */
export const liveRunGateReadable: PrivateFeedOptions['runGateReadable'] = async (userId) => {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  if (!user) return true;
  return (await readAppBlocksEnabled(user)) !== null;
};
