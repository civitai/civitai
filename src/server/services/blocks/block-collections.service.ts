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

import { Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/edge-url';
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
 * Fallback cover source for collections whose own cover is null OR is itself over
 * the ceiling: the media (url,type) of each collection's most-recent ACCEPTED
 * item WHOSE OWN `Image.nsfwLevel` is PERMITTED by the token's clamped
 * `browsingLevel`. This is the maturity clamp the discovery cover MUST apply — a
 * MIXED-bucket collection (nsfwLevel 29) intersects a SFW ceiling and passes the
 * collection-level discovery gate, but its newest item can be R/X; surfacing that
 * thumbnail on a SFW-domain / region-restricted token would leak mature media.
 *
 * The nsfw test is BITWISE (`nsfwLevel & browsingLevel != 0`, plus unrated 0 —
 * the identical authority the detail path + images service use), applied IN the
 * WHERE so `DISTINCT ON (collectionId)` picks the newest *permitted* item per
 * collection (filtering after `distinct` would drop the cover entirely). Returns
 * a Map keyed by collectionId; a collection with no permitted item is absent
 * (→ placeholder tile).
 */
export async function getFallbackCoverImages(
  collectionIds: number[],
  browsingLevel: number
): Promise<Map<number, { url: string | null; type: string | null }>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await dbRead.$queryRaw<
    { collectionId: number; url: string | null; type: string | null }[]
  >`
    SELECT DISTINCT ON (ci."collectionId")
      ci."collectionId" as "collectionId",
      i."url" as "url",
      i."type"::text as "type"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i."id" = ci."imageId"
    WHERE ci."collectionId" IN (${Prisma.join(collectionIds)})
      AND ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"
      AND ((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)
    ORDER BY ci."collectionId", ci."createdAt" DESC
  `;
  const map = new Map<number, { url: string | null; type: string | null }>();
  for (const r of rows) {
    if (r.collectionId != null && r.url) {
      map.set(r.collectionId, { url: r.url, type: r.type ?? null });
    }
  }
  return map;
}

/**
 * How many of a collection's newest ACCEPTED items the playable-fraction sample
 * reads. NOT a page size and NOT a display number — it is the width of the window
 * the discovery ranking heuristic looks at, and nothing outside this module should
 * need it.
 *
 * 🔴 WHY BOUNDED AT ALL, AND WHY 200. The exact clamped count — every accepted
 * item of every candidate collection, LEFT JOINed to "Image" — cannot be afforded
 * on this path. Measured on a production-scale replica over the real page-1
 * over-fetch window under the endpoint's default sort (97 collections, 298,469
 * accepted items, largest 34,577):
 *
 *     1 unclamped count, 24 ids (what main runs)   85 ms / 82 ms
 *     unclamped, 97 ids                            84 ms / 78 ms
 *     EXACT CLAMPED count, 97 ids                2829 ms / 2563 ms
 *     exact clamped, 24 ids                      2076 ms / 2079 ms
 *     bounded sample, cap 200/collection          257 ms
 *     bounded sample, cap 500/collection          354 ms
 *
 * The unclamped count is an Index Only Scan on the covering
 * (collectionId, status) index — no heap access at all. Joining "Image" forfeits
 * that index and becomes a Nested Loop Left Join over ~300k rows
 * (Buffers: shared hit=1713835). Narrowing the over-fetch is NOT the lever: the
 * same exact count over 24 ids instead of 97 still costs 2076 ms (~27%), because
 * the cost is concentrated in a handful of very large collections that are on
 * page 1 *because* the sort ranks them there. 500 buys nothing measurable over
 * 200 and widens the worst case, so 200 it is.
 *
 * ACCURACY, measured over those same 97 collections: a 200-item sample and the
 * exact clamped count agree on the 20% floor for 97 of 97 (63 keeps either way,
 * 0 disagreements).
 *
 * 🔴 BUT IT IS ORDER-SENSITIVE, which is why {@link getCollectionPlayableSample}
 * pins the order and must never be "simplified" to a bare LIMIT. Over the 84 of
 * those collections holding more than 200 items, an oldest-200 sample and a
 * newest-200 sample disagree on the floor verdict for 1 collection, and the worst
 * per-collection gap between the two ends is 0.800 — 80 percentage points, a
 * collection whose character changed completely over its life. Mean gap 0.038.
 * A bare `LIMIT 200` takes *physical* row order, which is neither stable nor
 * reviewable, and would make that 1-in-84 verdict a coin flip.
 */
export const PLAYABLE_SAMPLE_SIZE = 200;

export type CollectionPlayableSample = {
  /** Items actually read — `min(accepted items, PLAYABLE_SAMPLE_SIZE)`. */
  sampled: number;
  /** How many of those the viewer's ceiling permits. */
  playable: number;
};

/**
 * A BOUNDED, ORDER-PINNED sample of how much of each collection survives the
 * viewer's maturity ceiling: for every id, the newest
 * {@link PLAYABLE_SAMPLE_SIZE} accepted items, and how many of them are playable.
 *
 * 🔴 THIS IS AN APPROXIMATION OF A RANKING HEURISTIC, NOT A SAFETY GATE. It
 * decides whether a discovery card is worth *showing*, on the theory that a card
 * promising 2,080 items and opening onto 19 is a bad card. It protects nobody
 * from mature media and must never be described as if it did: per-item maturity
 * is enforced on the DETAIL endpoint, where the media is actually read, and on
 * the cover via `getFallbackCoverImages`. A collection this function keeps can
 * still be 79% mature, and a collection it drops was never unsafe.
 *
 * The returned fraction is `playable / sampled` — both bounded by the cap — so it
 * is the composition of the collection's RECENT items, not of the whole
 * collection. Its cost, accuracy and order-sensitivity are recorded on
 * {@link PLAYABLE_SAMPLE_SIZE}; read that before changing anything here.
 *
 * NEWEST-FIRST is the defensible end to look at: it is what a viewer opening the
 * collection sees first, and a collection that has recently gone mature should be
 * judged on what it is now rather than on what it was. `ci."id" DESC` is the
 * insertion-order surrogate for `createdAt` — a serial primary key, so ordering by
 * it needs no extra column on the row. (The 257 ms figure above was measured with
 * exactly this ordering; no claim is made here about which index the planner
 * picks, only that this shape is what was timed.)
 *
 * Shape notes, each of which is load-bearing:
 *   - CROSS JOIN LATERAL, so the LIMIT applies PER COLLECTION. A single ordered
 *     query with one LIMIT would sample the largest collection and nothing else.
 *   - LEFT JOIN "Image" plus an explicit `imageId IS NULL` escape, because
 *     `nsfwLevel` lives on "Image": an inner join would score every model / post /
 *     article item as unplayable and empty those collections out of discovery.
 *   - An item whose "Image" row is gone yields NULL on both halves of the bitwise
 *     test and counts as NOT playable — fail closed, matching
 *     `getFallbackCoverImages`, whose inner join drops the same row.
 *   - The maturity test is BITWISE (`& != 0`, plus unrated 0), the identical
 *     authority the detail path and the images service use. A `<=` would be
 *     wrong: 29 is a mixed bucket that intersects a SFW ceiling.
 *   - A collection with no countable accepted items produces NO ROW (the lateral
 *     is an inner join), so it is ABSENT from the map — which callers read as
 *     `sampled: 0`, i.e. "nothing to judge".
 */
export async function getCollectionPlayableSample(
  collectionIds: number[],
  browsingLevel: number,
  sampleSize: number = PLAYABLE_SAMPLE_SIZE
): Promise<Map<number, CollectionPlayableSample>> {
  if (collectionIds.length === 0) return new Map();
  // Cast each id so the array constructor's element type is unambiguous to the
  // planner rather than depending on parameter-type inference.
  const idList = Prisma.join(collectionIds.map((id) => Prisma.sql`${id}::int`));
  const rows = await dbRead.$queryRaw<{ id: number; sampled: number; playable: number }[]>`
    SELECT
      c."id" as "id",
      COUNT(*)::int as "sampled",
      COUNT(*) FILTER (
        WHERE s."imageId" IS NULL
           OR (i."nsfwLevel" & ${browsingLevel}) != 0
           OR i."nsfwLevel" = 0
      )::int as "playable"
    FROM unnest(ARRAY[${idList}]) AS c("id")
    CROSS JOIN LATERAL (
      SELECT ci."imageId" as "imageId"
      FROM "CollectionItem" ci
      WHERE ci."collectionId" = c."id"
        AND ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"
        AND (ci."imageId" IS NOT NULL OR ci."modelId" IS NOT NULL OR ci."postId" IS NOT NULL OR ci."articleId" IS NOT NULL)
      ORDER BY ci."id" DESC
      LIMIT ${sampleSize}
    ) s
    LEFT JOIN "Image" i ON i."id" = s."imageId"
    GROUP BY c."id"
  `;
  const map = new Map<number, CollectionPlayableSample>();
  for (const r of rows) {
    if (r.id == null) continue;
    map.set(Number(r.id), { sampled: Number(r.sampled), playable: Number(r.playable) });
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
