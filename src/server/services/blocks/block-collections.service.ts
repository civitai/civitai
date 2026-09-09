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
 * The cover fields a block collection card carries on the wire, produced TOGETHER
 * from ONE image so they can never describe different images.
 *
 * 🔴 `coverNsfwLevel` IS NOT THE COLLECTION'S `nsfwLevel`, AND THE NAME IS THE
 * GUARD. A Collection's own `nsfwLevel` is a bitmask OR-ed over its items, so a
 * 97%-safe contest collection and a 1%-safe mature one both carry 29 — it cannot
 * separate them, and a consumer that blurred on it would blur nearly everything or
 * nothing. This field is a much narrower claim: the maturity level of THE SINGLE
 * IMAGE being served as `coverImageUrl`, so a consumer can gate the thumbnail it
 * is actually about to paint. Never rename it to `nsfwLevel`.
 *
 * 🔴 ABSENT MEANS "NO COVER", AND `0` IS A REAL LEVEL (unrated). Consumers branch
 * on `undefined` (→ fall back to their own domain ceiling) versus a supplied
 * value (→ authoritative, gate on it), so emitting `0` for "there is no cover"
 * would silently move them onto the wrong path. When `coverImageUrl` is null the
 * field is OMITTED; when a cover exists and is unrated, `0` is published as a real
 * value.
 */
export type BlockCollectionCoverFields = {
  coverImageUrl: string | null;
  coverNsfwLevel?: number;
};

/**
 * Project ONE image into the pair of cover fields — the url and the maturity level
 * OF THAT SAME IMAGE.
 *
 * 🔴 WHY THIS IS ONE FUNCTION AND NOT TWO. The discovery cover is the primary
 * `Collection.image` OR a maturity-clamped fallback item, chosen per collection.
 * Publishing the primary's level beside a fallback url is WORSE than publishing
 * nothing: a consumer treats a supplied level as authoritative and an absent one as
 * "fall back to the ceiling", so a mismatched level is a lie it will gate on.
 * Taking a single image and emitting both fields from it makes the mismatch
 * unrepresentable rather than merely tested for — the caller picks the image once.
 *
 * SEMANTIC OF THE LEVEL: it is the level of THE IMAGE BEING SERVED as the cover,
 * whichever image that is. For a fallback cover that image is the collection's
 * NEWEST clamped accepted item (`getFallbackCoverImages` orders by
 * `ci."createdAt" DESC`) — it is deliberately not a "best" or "highest-rated"
 * representative, and nothing here ranks items.
 *
 * The `coverImageUrl === null` test — not a separate "is there an image" check —
 * is what ties the presence of the level to the presence of the url: the two are
 * decided by the same expression, so they cannot drift apart.
 */
export function toCoverFields(
  image: { url?: string | null; type?: string | null; nsfwLevel?: number | null } | null | undefined
): BlockCollectionCoverFields {
  const coverImageUrl = toCoverImageUrl(image);
  // No cover → the field is ABSENT (not 0); see the type's doc comment.
  if (coverImageUrl === null) return { coverImageUrl: null };
  // A cover with a null/absent level is UNRATED, which is the real level 0 — the
  // same `?? 0` normalisation every other maturity read on this surface uses.
  return { coverImageUrl, coverNsfwLevel: image?.nsfwLevel ?? 0 };
}

/**
 * Fallback cover source for collections whose own cover is null OR is itself over
 * the ceiling: the media (url,type,nsfwLevel) of each collection's most-recent
 * ACCEPTED item WHOSE OWN `Image.nsfwLevel` is PERMITTED by the token's clamped
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
 *
 * 🔴 `nsfwLevel` IS SELECTED, NOT JUST FILTERED ON. The endpoint publishes the
 * level of the cover it actually serves (`toCoverFields`), and for a fallback
 * cover THIS row is that cover — so its own level has to travel with it. Reading
 * the primary `Collection.image`'s level instead would describe a different image
 * (that is precisely the image this map exists to REPLACE), which is the one
 * failure mode a maturity field must not have.
 */
export async function getFallbackCoverImages(
  collectionIds: number[],
  browsingLevel: number
): Promise<Map<number, { url: string | null; type: string | null; nsfwLevel: number }>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await dbRead.$queryRaw<
    { collectionId: number; url: string | null; type: string | null; nsfwLevel: number | null }[]
  >`
    SELECT DISTINCT ON (ci."collectionId")
      ci."collectionId" as "collectionId",
      i."url" as "url",
      i."type"::text as "type",
      i."nsfwLevel" as "nsfwLevel"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i."id" = ci."imageId"
    WHERE ci."collectionId" IN (${Prisma.join(collectionIds)})
      AND ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"
      AND ((i."nsfwLevel" & ${browsingLevel}) != 0 OR i."nsfwLevel" = 0)
    ORDER BY ci."collectionId", ci."createdAt" DESC
  `;
  const map = new Map<number, { url: string | null; type: string | null; nsfwLevel: number }>();
  for (const r of rows) {
    if (r.collectionId != null && r.url) {
      // An unrated image stores 0; a null column read is the same "unrated" claim.
      map.set(r.collectionId, { url: r.url, type: r.type ?? null, nsfwLevel: r.nsfwLevel ?? 0 });
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
 *     THIS QUERY, as shipped (ORDER BY id DESC)   399 ms / 412 ms
 *     ...same, but a bare LIMIT with no ORDER BY  102 ms / 107 ms
 *     unordered sample, cap 500/collection        354 ms
 *
 * 🔴 THE LAST THREE ROWS ARE THE CORRECTION, AND THE REASON THEY ARE SPELLED OUT.
 * An earlier revision of this block quoted 257 ms for "the bounded sample" and
 * said it had been measured "with exactly this ordering". It had not: 257 ms was
 * an UNORDERED `LIMIT 200`, and the order pin this design depends on was added
 * afterwards. Re-measured on the shipped shape it is ~400 ms — still 7x cheaper
 * than the exact clamp it replaces, but ~4x the unordered variant and ~4.7x the
 * unclamped baseline, which is a different trade than the one the old number
 * described. The figure was never asserted on by anything, which is exactly how
 * it survived into a comment, a commit message and a PR body.
 *
 * WHERE THE ORDER PIN'S COST COMES FROM, since ~4x is more than it looks like it
 * should be: there is no index giving (collectionId, status) rows in id order, so
 * the LATERAL reads the WHOLE collection via the covering index — 3,077 rows on
 * average, 34,577 at the tail — and quicksorts it before taking 200. The cap
 * bounds what the JOIN and the count touch, NOT what the scan reads. An index on
 * (collectionId, status, id DESC) would remove the sort; that is a migration, and
 * migrations here are applied by hand per environment, so it is deliberately left
 * as a follow-up rather than smuggled into this PR.
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
 * it needs no extra column on the row. (The ~400 ms figure on
 * {@link PLAYABLE_SAMPLE_SIZE} was measured on THIS shape, ordering included —
 * see the correction recorded there, because the number that preceded it was
 * measured on the unordered variant and was ~4x too low.)
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
