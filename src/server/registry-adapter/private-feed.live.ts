/**
 * The private feed's live dependencies (`private-feed.ts`): the document store's private reads and
 * THE collection-read predicate, `decideCollectionRead` (`data-read-grant.ts`), never a copy of it.
 */
import type {
  DecideCollectionRead,
  PrivateDocSource,
  PrivateFeedOptions,
} from '~/server/registry-adapter/private-feed';
import type { ViewerDocSource } from '~/server/registry-adapter/viewer-feed';
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
    versions: (appId, coll, userId, afterKey, limit) =>
      feed.privateVersions(appId, coll, userId, afterKey, limit),
    documents: (appId, coll, userId, afterKey, limit) =>
      feed.privateDocuments(appId, coll, userId, afterKey, limit),
  };
}

/**
 * The per-viewer stream's reads (`viewer-feed.ts`): one user's OWN shared documents, from the same
 * private-feed object (it is keyed on a caller-supplied user id, so it lives behind the same
 * ledger), and the same head.
 */
export function liveViewerDocSource(): ViewerDocSource {
  const feed = getDocStorePrivateFeed();
  return {
    head: (appId) => feed.privateHead(appId),
    versions: (appId, coll, userId, domain, afterKey, limit) =>
      feed.viewerVersions(appId, coll, userId, domain, afterKey, limit),
    documents: (appId, coll, userId, domain, afterKey, limit) =>
      feed.viewerDocuments(appId, coll, userId, domain, afterKey, limit),
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
