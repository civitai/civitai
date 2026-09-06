import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  getAllCollections,
  getCollectionItemCount,
  getUserCollectionsWithPermissions,
} from '~/server/services/collection.service';
import {
  collectionWithinCeiling,
  getCollectionPlayableSample,
  getFallbackCoverImages,
  getFollowedCollectionIds,
  hydrateBlockSubject,
  toCoverImageUrl,
} from '~/server/services/blocks/block-collections.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { CollectionSort } from '~/server/common/enums';
import {
  CollectionItemStatus,
  CollectionReadConfiguration,
  CollectionType,
} from '~/shared/utils/prisma/enums';

/**
 * GET /api/v1/blocks/collections?mode=public|mine&query&sort&cursor&limit
 *
 * Block-token collection DISCOVERY for App Blocks. Scope `collections:read:self`.
 *
 *   - mode=public → public collections (name-searchable, sortable) via the
 *     existing `getAllCollections` service (privacy pinned to Public).
 *   - mode=mine   → the SUBJECT's OWN collections (public + private) via the
 *     existing `getUserCollectionsWithPermissions` service, keyed on the verified
 *     token subject (never a client-supplied userId).
 *
 * Maturity: collections whose own `nsfwLevel` exceeds the token's clamped ceiling
 * (`claims.maxBrowsingLevel`, region-narrowed) are dropped — a SFW-domain block
 * can't surface a mature collection in discovery. (Per-item maturity is enforced
 * on the detail endpoint where the media is actually read.)
 *
 * 🔴 THE COLLECTION-LEVEL `nsfwLevel` CANNOT SEPARATE A MOSTLY-SAFE COLLECTION
 * FROM A MOSTLY-MATURE ONE, which is why the clamped count below exists. It is a
 * bitmask OR-ed over the collection's items, so a contest collection that is 97%
 * safe and a mature collection that is 1% safe both carry the same value (29 =
 * PG|R|X|XXX) and both INTERSECT a SFW ceiling. Gating harder on that value is not
 * an option: strict containment (`nsfwLevel & ~browsingLevel === 0`) was measured
 * against the live population and drops 87.5% of the first discovery page,
 * including the large contest collections that are the best content on a SFW
 * domain. The separating signal is HOW MUCH OF THE COLLECTION SURVIVES THE
 * CEILING, sampled — see `MIN_PLAYABLE_FRACTION` and `PLAYABLE_SAMPLE_SIZE`.
 *
 * Response: `{ items: [{ id, name, description, coverImageUrl, itemCount,
 *   curator:{ userId, username }, isPublic, followed }], nextCursor }`.
 *
 * 🔴 `itemCount` DIFFERS BY MODE, DELIBERATELY. In `mode=mine` it is CLAMPED to
 * the token's ceiling — that branch counts only the subject's own collections, a
 * bounded set with no over-fetch window, so the exact clamped count is affordable
 * there. In `mode=public` it is the collection's ADVERTISED (unclamped) size: the
 * exact clamped count over the discovery over-fetch window is a ~31× regression
 * on this endpoint (measured; see `PLAYABLE_SAMPLE_SIZE`), and the sampled
 * fraction that replaces it is an ESTIMATE, which a field that reads as exact
 * must not carry. The advertised number is not a lie — it is the collection's
 * real size — and the playable floor now guarantees that most of it is playable.
 */

export const config = { api: { responseLimit: false } };

// Block-friendly `sort` aliases → the internal CollectionSort enum. Accepted IN
// ADDITION to the raw enum values (backward-compat), so a block may send the
// simple `newest`/`popular` OR the underlying `Newest`/`Most Followers`. There is
// no media-count popularity sort on the service — `popular` maps to the closest
// available ranking, MostContributors ('Most Followers').
const SORT_ALIAS: Record<string, CollectionSort> = {
  newest: CollectionSort.Newest,
  popular: CollectionSort.MostContributors,
};

/**
 * The PLAYABLE-FRACTION FLOOR: the share of a collection's SAMPLED accepted items
 * that must survive the viewer's maturity ceiling for that collection to be worth
 * surfacing in PUBLIC discovery.
 *
 * A collection at 1% is not a collection the viewer can browse; it is a card
 * promising 2,080 items that opens onto 19. Twenty percent is the point measured
 * to separate the two live populations — the mostly-safe contest collections sit
 * far above it and the mature ones far below — without needing a second signal.
 *
 * 🔴 A RANKING HEURISTIC, NOT A SAFETY GATE, AND IT IS FED BY A SAMPLE. The
 * fraction is computed over the newest `PLAYABLE_SAMPLE_SIZE` items, not over the
 * whole collection (the exact clamped count is unaffordable here — the cost,
 * accuracy and order-sensitivity measurements live on that constant). Nothing on
 * this path protects a viewer from mature media: per-item maturity is enforced on
 * the DETAIL endpoint where the media is read, and on the cover via
 * `getFallbackCoverImages`. A collection kept by this floor can still be 79%
 * mature.
 *
 * 🔴 DISCOVERY ONLY. It is deliberately NOT applied in `mode=mine`; see the drop
 * comment on the public branch and the note above the `mine` branch.
 */
export const MIN_PLAYABLE_FRACTION = 0.2;

/**
 * Does `playable` of `sampled` items clear {@link MIN_PLAYABLE_FRACTION}?
 *
 * 🔴 THE ZERO CASE IS AN EXPLICIT BRANCH, NOT A DIVISION. A collection with
 * nothing sampled gives `0 / 0 = NaN`, and every comparison against NaN is false
 * — so without this guard it would be silently DROPPED by a filter that has
 * nothing to say about it. This filter exists to catch a MATURITY MISMATCH
 * between what a card advertises and what it can serve, and a collection with no
 * items has no mismatch to detect. Whether an empty collection belongs in
 * discovery at all is a separate product question this must not decide as a side
 * effect.
 */
export function meetsPlayableFloor(sampled: number, playable: number): boolean {
  if (sampled <= 0) return true;
  return playable / sampled >= MIN_PLAYABLE_FRACTION;
}

const querySchema = z.object({
  mode: z.enum(['public', 'mine']).default('public'),
  query: z.string().trim().max(100).optional(),
  // Preprocess maps a friendly alias (case-insensitive) to the enum value; a raw
  // enum value passes through unchanged; undefined falls to the enum default.
  sort: z.preprocess(
    (v) => (typeof v === 'string' ? SORT_ALIAS[v.toLowerCase()] ?? v : v),
    z.enum(CollectionSort).default(CollectionSort.Newest)
  ),
  // Keyset cursor on the collection id (both modes order by id DESC).
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let subjectUserId: number | null;
  try {
    subjectUserId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (subjectUserId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not read collections' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    return;
  }
  const { mode, query, sort, cursor, limit } = parsed.data;

  // Per-instance rate limit (shared blocks catalog limiter) — bounds a block
  // hammering this private,no-store route onto the origin.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  const subjectUser = await hydrateBlockSubject(subjectUserId);
  if (!subjectUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  try {
    if (mode === 'public') {
      // Over-fetch so the maturity clamp can't under-fill the page and terminate
      // pagination early (which would make later public collections unreachable).
      // Walk the (createdAt DESC) rows collecting visible ones until the page is
      // full, then continue the keyset from the FIRST fetched row we did NOT
      // consume. getAllCollections' cursor is INCLUSIVE, so pointing next page's
      // cursor at that first-unconsumed row resumes exactly there — no gap (the
      // clamped-out rows before it were already walked past) and no duplicate (it
      // was not shown on this page).
      const OVERFETCH = limit * 4 + 1;
      const rows = await getAllCollections({
        input: {
          limit: OVERFETCH,
          cursor,
          query,
          sort,
          privacy: [CollectionReadConfiguration.Public],
          // MEDIA collections only — a Model/Article/Post collection renders an
          // empty player (the detail endpoint drops non-image items), so restrict
          // discovery to Image collections (which hold images + videos).
          types: [CollectionType.Image],
        },
        user: subjectUser,
        select: {
          id: true,
          name: true,
          description: true,
          read: true,
          nsfwLevel: true,
          userId: true,
          user: { select: { id: true, username: true } },
          image: { select: { url: true, type: true, nsfwLevel: true } },
        },
      });

      // The playable-fraction floor decides which rows the walk below consumes, so
      // it has to be resolved BEFORE the walk, over every row that could still
      // appear — not after the page is chosen. Only rows that already clear the
      // collection-level ceiling can appear, so those are the only ids worth
      // sampling.
      //
      // 🔴 SAMPLED, NOT COUNTED, AND THAT IS THE WHOLE COST STORY. Computing the
      // EXACT clamped count over this over-fetch window costs ~2.6-2.8 s against
      // the ~85 ms this endpoint takes without it — a ~31× regression on the
      // discovery front door — because the clamp's join to "Image" forfeits the
      // covering index the unclamped count scans. Narrowing OVERFETCH does not
      // rescue it (~27%). One bounded, order-pinned LATERAL sample costs ~400 ms
      // as shipped and agreed with the exact count on this floor for 97 of 97 live
      // collections. Measurements, the order-sensitivity that forces the ORDER BY,
      // and why that pin costs ~4x an unordered LIMIT are on
      // `PLAYABLE_SAMPLE_SIZE` — including the retraction of an earlier 257 ms
      // figure that had been measured WITHOUT the ordering.
      const ceilingOk = (c: (typeof rows)[number]) =>
        collectionWithinCeiling(c.nsfwLevel ?? 0, browsingLevel);
      const candidateIds = rows.filter(ceilingOk).map((c) => c.id);
      const playableSample = await getCollectionPlayableSample(candidateIds, browsingLevel);

      const items: typeof rows = [];
      let firstUnconsumedId: number | undefined;
      for (let i = 0; i < rows.length; i++) {
        if (items.length >= limit) {
          firstUnconsumedId = rows[i].id;
          break;
        }
        if (!ceilingOk(rows[i])) continue;
        // 🔴 THE DROP, AND WHY IT IS INSIDE THIS WALK RATHER THAN AFTER IT. The
        // sample map is absent-means-nothing-sampled (the lateral emits no row for
        // a collection with no accepted items), which `meetsPlayableFloor` reads as
        // "nothing to judge, keep". Filtering here means a dropped row is walked
        // PAST like a clamped-out one, so the page still fills to `limit` and
        // `firstUnconsumedId` still advances — filtering the sliced page afterwards
        // would return short pages and, on a page that filtered to empty, emit no
        // cursor at all and TERMINATE the feed while qualifying collections
        // remained.
        const sample = playableSample.get(rows[i].id);
        if (!meetsPlayableFloor(sample?.sampled ?? 0, sample?.playable ?? 0)) continue;
        items.push(rows[i]);
      }

      let nextCursor: number | undefined;
      if (firstUnconsumedId !== undefined) {
        // Page filled AND at least one fetched row remains → clean inclusive resume.
        nextCursor = firstUnconsumedId;
      } else if (rows.length === OVERFETCH) {
        // Consumed the ENTIRE over-fetch without filling `limit` (a very heavy
        // clamp) yet the source returned a full batch → more may remain. Resume
        // from the last fetched row (inclusive → re-fetched next page; the client
        // dedups by id). No longer rare: the playable floor drops far more rows
        // than the ceiling alone did, so a page CAN come back short — but it comes
        // back with a cursor that advanced by OVERFETCH-1 rows, which is what
        // keeps the rest of the feed reachable. Short page, live feed.
        nextCursor = rows[rows.length - 1]?.id;
      }
      // else: rows.length < OVERFETCH and the page wasn't over-consumed → the
      // source is exhausted → no nextCursor.

      const ids = items.map((c) => c.id);
      // Cover fallback + MATURITY CLAMP: a cover is usable only when it exists AND
      // its own nsfwLevel is within the token's clamped ceiling. A MIXED-bucket
      // collection can pass the collection-level discovery gate (bitwise) yet have
      // a mature cover / first item, so an unclamped cover would leak mature media
      // on a SFW-domain / region-restricted token. When the primary cover is null
      // OR over the ceiling, fall back to the newest CLAMPED item (same authority
      // the detail path uses).
      const primaryCoverUsable = (c: (typeof items)[number]) =>
        !!c.image?.url && collectionWithinCeiling(c.image.nsfwLevel ?? 0, browsingLevel);
      const missingCoverIds = items.filter((c) => !primaryCoverUsable(c)).map((c) => c.id);
      const [countRows, followed, fallbackCovers] = await Promise.all([
        // 🔴 THE ADVERTISED (UNCLAMPED) COUNT — the same query, over the same
        // `limit`-sized id list, that this endpoint has always run. It is not a
        // lie: it is the collection's real size, and the floor above now
        // guarantees most of it is playable. It is deliberately NOT the sampled
        // fraction extrapolated to a total — `itemCount` reads as an exact number
        // and must not carry an estimate — and it is deliberately not the exact
        // clamped count, which is the ~31× regression this design exists to avoid.
        getCollectionItemCount({ collectionIds: ids, status: CollectionItemStatus.ACCEPTED }),
        getFollowedCollectionIds(subjectUserId, ids),
        getFallbackCoverImages(missingCoverIds, browsingLevel),
      ]);
      const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

      res.status(200).json({
        items: items.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description ?? null,
          coverImageUrl: toCoverImageUrl(primaryCoverUsable(c) ? c.image : fallbackCovers.get(c.id)),
          itemCount: countMap.get(c.id) ?? 0,
          curator: { userId: c.userId, username: c.user?.username ?? null },
          isPublic: c.read === CollectionReadConfiguration.Public,
          followed: followed.has(c.id),
        })),
        nextCursor,
      });
      return;
    }

    // mode === 'mine' — the subject's own collections. The service returns the
    // FULL owned+contributed set (no DB pagination), so we apply the name filter +
    // keyset (id DESC) slice in-memory. A user's own collection set is bounded.
    //
    // READ SPLIT: own PUBLIC collections are always returned (collections:read:self
    // gated the endpoint). Own NON-PUBLIC collections (Private/Unlisted — anything
    // not `Public`) are included ONLY when the token ALSO carries the consent-gated
    // `collections:read:private` scope; otherwise they are omitted entirely.
    const canReadPrivate = claims.scopes.includes('collections:read:private');
    const owned = await getUserCollectionsWithPermissions({
      input: { userId: subjectUserId, contributingOnly: true },
    });

    const needle = query?.toLowerCase();
    const filtered = owned
      .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
      // Read split: hide non-public own collections unless read:private is granted.
      .filter((c) => canReadPrivate || c.read === CollectionReadConfiguration.Public)
      .filter((c) => (cursor ? c.id < cursor : true))
      .sort((a, b) => b.id - a.id);

    let items = filtered;
    let nextCursor: number | undefined;
    if (items.length > limit) {
      items = items.slice(0, limit);
      nextCursor = items[items.length - 1]?.id;
    }

    const ids = items.map((c) => c.id);
    // Same maturity clamp as public discovery: a primary cover over the ceiling
    // (or null) falls back to the newest CLAMPED item so a SFW-domain / region-
    // restricted token never gets a mature thumbnail — even for own collections.
    const primaryCoverUsable = (c: (typeof items)[number]) =>
      !!c.image?.url && collectionWithinCeiling(c.image.nsfwLevel ?? 0, browsingLevel);
    const missingCoverIds = items.filter((c) => !primaryCoverUsable(c)).map((c) => c.id);
    const [countRows, followed, fallbackCovers] = await Promise.all([
      // 🔴 THE EXACT CLAMPED COUNT, WHICH THIS BRANCH CAN AFFORD AND PUBLIC
      // DISCOVERY CANNOT. `itemCount` here is the number the player will serve, so
      // a viewer's own card never promises items their ceiling hides. The reason
      // the same choice is impossible on the public branch is not the query — it
      // is the POPULATION. This branch counts only the subject's own collections:
      // a bounded set, already sliced to `limit`, with no over-fetch window and no
      // 34,577-item contest collection dragged in by a popularity sort. Public
      // discovery counts up to `limit * 4 + 1` candidates chosen precisely because
      // the sort ranks the biggest ones first, which is what turns the same clamp
      // into a ~2.6 s query (see `PLAYABLE_SAMPLE_SIZE`).
      //
      // 🔴 AND NO PLAYABLE-FRACTION FLOOR ON THIS BRANCH, DELIBERATELY. These are
      // the SUBJECT'S OWN collections: they created or bookmarked every one of
      // them and know it is in this list. Dropping one for being mostly mature
      // makes it look deleted, which is the defect class the detail surface
      // already settled the other way — an empty own-collection is shown DISABLED
      // WITH A REASON, never hidden. The floor is a DISCOVERY ranking filter, and
      // there is nothing to discover in a list the viewer assembled.
      getCollectionItemCount({
        collectionIds: ids,
        status: CollectionItemStatus.ACCEPTED,
        browsingLevel,
      }),
      getFollowedCollectionIds(subjectUserId, ids),
      getFallbackCoverImages(missingCoverIds, browsingLevel),
    ]);
    const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

    res.status(200).json({
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description ?? null,
        coverImageUrl: toCoverImageUrl(primaryCoverUsable(c) ? c.image : fallbackCovers.get(c.id)),
        itemCount: countMap.get(c.id) ?? 0,
        curator: { userId: c.userId, username: subjectUser.username ?? null },
        isPublic: c.read === CollectionReadConfiguration.Public,
        followed: followed.has(c.id),
      })),
      nextCursor,
    });
    return;
  } catch (error) {
    res.status(500).json({ error: 'Failed to load collections' });
    return;
  }
});

// Scope-gated: collections:read:self (self-scope → non-anon subject enforced by
// the middleware). Not the "any valid token" catalog mode — reads are subject-
// bound (own private collections), so a declared+granted scope is the gate.
// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'collections',
  requiredScope: 'collections:read:self',
  allowOpaqueOrigin: true,
});
