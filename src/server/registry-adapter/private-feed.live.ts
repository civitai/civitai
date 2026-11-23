/**
 * The private feed's live dependencies (`private-feed.ts`): the document store's private reads and
 * THE collection-read predicate, `decideCollectionRead` (`data-read-grant.ts`), never a copy of it.
 */
import type {
  DecideCollectionRead,
  PrivateDocSource,
  PrivateFeedOptions,
} from '~/server/registry-adapter/private-feed';
import { sessionClient } from '~/server/auth/session-client';
import { readAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { subjectForUserId } from '~/server/services/block-token-subject';
import { decideCollectionRead } from '~/server/services/apps/data-read-grant';
import { getDocStorePrivateFeed } from '~/server/services/apps/doc-store-private-feed.instance';
import type { SessionUser } from '~/types/session';

export function livePrivateDocSource(): PrivateDocSource {
  const feed = getDocStorePrivateFeed();
  return {
    head: (appId) => feed.privateHead(appId),
    markHead: (appId) => feed.privateMarkHead(appId),
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

/**
 * A block-exchange token's install revocation: THE check the site's `withBlockScope` runs
 * (`BlockRevocation.isRevoked`), with the subject the block token carried (`user:<id>`), so the
 * subject-scoped ban key is read for the one install shape that has it. Fails open, as there.
 */
export const liveInstanceRevoked: PrivateFeedOptions['instanceRevoked'] = (
  blockInstanceId,
  userId
) => BlockRevocation.isRevoked(blockInstanceId, subjectForUserId(userId));
