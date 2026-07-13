/**
 * Shared helpers for the App Blocks COLLECTIONS surface
 * (`/api/v1/blocks/collections*`). Keeps the three REST endpoints
 * (discovery, detail, follow) DRY without re-implementing any collection
 * business logic — every real read/write goes through the existing
 * `collection.service` functions; this module only:
 *   - hydrates the block-token SUBJECT into a full SessionUser (the authority
 *     for ownership/visibility + the viewer identity the collection services
 *     accept), mirroring apps-shared.router / blocks.router;
 *   - resolves which of a set of collections the subject already FOLLOWS
 *     (a plain CollectionContributor membership read — the on-site "follow" is
 *     a contributor row, added by `addContributorToCollection`);
 *   - maps a collection cover Image + a collection Image item to the block
 *     wire contracts (edge-url composed, maturity already clamped upstream).
 *
 * NOTE the maturity clamp itself is NOT applied here — the caller resolves the
 * token ceiling via `resolveCatalogBrowsingLevel(claims)` and passes the clamped
 * `browsingLevel` into the collection item service, so items are filtered at the
 * source (identical authority surface to /api/v1/blocks/images). Discovery
 * additionally drops collections whose own `nsfwLevel` exceeds the ceiling.
 */

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dbRead } from '~/server/db/client';
import { sessionClient } from '~/server/auth/session-client';
import type { SessionUser } from '~/types/session';
import { Flags } from '~/shared/utils/flags';

/**
 * Resolve the FULL server-side SessionUser for a verified block-token subject
 * userId. Fail-closed: a vanished subject resolves to null and the caller
 * refuses. Same resolver the shared-storage + blocks routers use.
 */
export async function hydrateBlockSubject(userId: number): Promise<SessionUser | null> {
  return (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
}

/**
 * Which of `collectionIds` the `userId` currently follows on-site. The on-site
 * follow is a `CollectionContributor` row (see `addContributorToCollection`), so
 * membership in that table IS the "followed" signal. Returns an empty set for an
 * empty id list. Never throws — a lookup failure surfaces as "not followed"
 * rather than failing the read.
 */
export async function getFollowedCollectionIds(
  userId: number,
  collectionIds: number[]
): Promise<Set<number>> {
  if (collectionIds.length === 0) return new Set();
  const rows = await dbRead.collectionContributor.findMany({
    where: { userId, collectionId: { in: collectionIds } },
    select: { collectionId: true },
  });
  return new Set(rows.map((r) => r.collectionId));
}

/**
 * Compose a directly-usable CDN url for a collection cover / media Image from its
 * stored key + media type. Returns null when there is no image key. Mirrors the
 * `getEdgeUrl(image.url, { original: true, type })` shape the public
 * /api/v1/images formatter uses so blocks get a ready-to-render url.
 */
export function toMediaUrl(
  image: { url?: string | null; type?: string | null } | null | undefined
): string | null {
  if (!image?.url) return null;
  return getEdgeUrl(image.url, {
    original: true,
    type: (image.type as 'image' | 'video' | undefined) ?? 'image',
  });
}

/** True iff the collection's own nsfwLevel is permitted by the clamped ceiling. */
export function collectionWithinCeiling(nsfwLevel: number, browsingLevel: number): boolean {
  // A level of 0 (unrated) is always allowed; otherwise it must intersect the
  // clamped browsing level (identical bitwise test the feed uses).
  if (!nsfwLevel) return true;
  return Flags.intersects(nsfwLevel, browsingLevel);
}

export type BlockCollectionMediaItem = {
  mediaId: number;
  type: 'image' | 'video';
  url: string | null;
  width: number | null;
  height: number | null;
  creator: { userId: number; username: string | null } | null;
  nsfwLevel: number;
};

/**
 * Map an IMAGE-type expanded collection item (`getCollectionItemsByCollectionId`
 * → `{ type: 'image', data: ImagesInfiniteModel }`) to the block media contract.
 */
export function mapImageItemToMedia(data: {
  id: number;
  url?: string | null;
  type?: string | null;
  width?: number | null;
  height?: number | null;
  nsfwLevel?: number | null;
  user?: { id: number; username?: string | null } | null;
}): BlockCollectionMediaItem {
  const mediaType: 'image' | 'video' = data.type === 'video' ? 'video' : 'image';
  return {
    mediaId: data.id,
    type: mediaType,
    url: toMediaUrl({ url: data.url, type: mediaType }),
    width: data.width ?? null,
    height: data.height ?? null,
    creator: data.user ? { userId: data.user.id, username: data.user.username ?? null } : null,
    nsfwLevel: data.nsfwLevel ?? 0,
  };
}
