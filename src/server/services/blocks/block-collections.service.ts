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
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

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

/**
 * Compose a directly-`<img>`-renderable COVER url for a collection cover Image.
 * Identical to `toMediaUrl` for a still image, but for a VIDEO cover it requests
 * a transcoded still frame (`type: 'image'` + `transcode` + `anim: false`) so the
 * returned url is a poster/first-frame JPEG — NOT the raw `.mp4` an `<img>` tag
 * can't display (the cause of the "missing thumbnail" cards). Returns null when
 * there is no image key so the block renders its placeholder tile.
 *
 * Distinct from `toMediaUrl` (used for the player's media items, where a video
 * item must keep its playable `.mp4` url).
 */
export function toCoverImageUrl(
  image: { url?: string | null; type?: string | null } | null | undefined
): string | null {
  if (!image?.url) return null;
  const isVideo = image.type === 'video';
  return isVideo
    ? getEdgeUrl(image.url, { original: true, type: 'image', transcode: true, anim: false })
    : getEdgeUrl(image.url, { original: true, type: 'image' });
}

/**
 * Fallback cover source for collections whose own `image` (cover) is null: the
 * media (url,type) of each collection's most-recent ACCEPTED image/video item.
 * Batched (one query for all ids) with `distinct` on collectionId so we take a
 * single representative item per collection. Returns a Map keyed by collectionId;
 * collections with no accepted media item are simply absent (→ placeholder tile).
 */
export async function getFallbackCoverImages(
  collectionIds: number[]
): Promise<Map<number, { url: string | null; type: string | null }>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await dbRead.collectionItem.findMany({
    where: {
      collectionId: { in: collectionIds },
      imageId: { not: null },
      status: CollectionItemStatus.ACCEPTED,
    },
    select: {
      collectionId: true,
      image: { select: { url: true, type: true } },
    },
    orderBy: [{ collectionId: 'asc' }, { createdAt: 'desc' }],
    distinct: ['collectionId'],
  });
  const map = new Map<number, { url: string | null; type: string | null }>();
  for (const r of rows) {
    if (r.collectionId != null && r.image?.url) {
      map.set(r.collectionId, { url: r.image.url, type: r.image.type ?? null });
    }
  }
  return map;
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
