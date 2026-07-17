import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { CollectionSort } from '~/server/common/enums';
import {
  getAllCollections,
  getCollectionItemCount,
} from '~/server/services/collection.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNextPage } from '~/server/utils/pagination-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  CollectionItemStatus,
  CollectionReadConfiguration,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

/**
 * GET /api/v1/collections — public, edge-cacheable list/search over collections.
 *
 * Wraps the EXISTING `getAllCollections` service (no reimplemented business
 * logic). This endpoint serves PUBLIC data only: privacy is pinned to `[Public]`
 * AND the caller identity is dropped (`user: undefined`), so the service's own
 * clamp forces Public UNCONDITIONALLY — an anonymous caller and any authenticated
 * caller hitting the same URL get byte-identical data. That caller-independence is
 * what makes the `MixedAuthEndpoint` wrapper's `public, s-maxage=300` edge caching
 * safe (no cross-user leak). There is NO `mine=` mode here — own-collection
 * discovery is inherently per-user (uncacheable + authoring), not public
 * discovery. A private collection is therefore unreachable here.
 *
 * Maturity is clamped to the region-narrowed browsing ceiling (a collection /
 * cover above the ceiling is dropped or its cover nulled), matching the other
 * public endpoints — the one legitimate region-derived response variation.
 *
 * Envelope: `{ items, metadata: { nextCursor, nextPage } }` (keyset cursor on the
 * collection id, id DESC), consistent with the other public v1 endpoints.
 */

export const config = {
  api: {
    responseLimit: false,
  },
};

const collectionsEndpointSchema = z.object({
  limit: z.preprocess((val) => Number(val), z.number().min(1).max(100)).default(100),
  cursor: z.coerce.number().int().positive().optional(),
  query: z.string().trim().max(100).optional(),
  sort: z.enum(CollectionSort).optional(),
  nsfw: booleanString().optional(),
});

// A level of 0 (unrated) is always allowed; otherwise it must intersect the
// clamped browsing level (identical bitwise test the feed / block endpoints use).
function withinCeiling(nsfwLevel: number | null | undefined, browsingLevel: number): boolean {
  if (!nsfwLevel) return true;
  return Flags.intersects(nsfwLevel, browsingLevel);
}

type CollectionListItem = {
  id: number;
  name: string;
  description: string | null;
  type: string | null;
  nsfwLevel: number | null;
  read: CollectionReadConfiguration;
  isPublic: boolean;
  itemCount: number;
  coverImageUrl: string | null;
  user: { id: number | null; username: string | null };
};

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Conservative per-client rate limit (before the expensive service call). The
  // limiter keys on CF-Connecting-IP / userId — it only guards the cache-MISS
  // path (varied-query scraping); the response body itself never varies by user.
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'collections', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsedParams = collectionsEndpointSchema.safeParse(req.query);
  if (!parsedParams.success) return res.status(400).json({ error: parsedParams.error });

  const { limit, cursor, query, sort, nsfw } = parsedParams.data;

  const region = getRegion(req);
  let browsingLevel = !nsfw ? publicBrowsingLevelsFlag : allBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  const coverUrl = (
    image: { url: string; type: MediaType | null; nsfwLevel: number | null } | null | undefined
  ): string | null =>
    image?.url && withinCeiling(image.nsfwLevel, browsingLevel)
      ? getEdgeUrl(image.url, { width: 450, type: image.type ?? undefined })
      : null;

  try {
    // Public discovery. The keyset cursor is id-based, which only tracks the
    // default `createdAt DESC` ordering. Under `sort=MostContributors`
    // `getAllCollections` orders by contributor `_count` — an id cursor there
    // positions Prisma at an arbitrary point in that ordering, silently
    // skipping/duplicating rows across pages. Rather than return corrupt pages,
    // reject the unsupported combination explicitly. (First-page reads with
    // `MostContributors` and NO cursor are still fine.)
    if (sort === CollectionSort.MostContributors && cursor !== undefined) {
      return res.status(400).json({
        error:
          'Cursor pagination is only supported for the default (Newest) sort. ' +
          'Omit `sort=Most Followers` when paginating with a cursor, or request the first page without a cursor.',
      });
    }

    // Over-fetch so the maturity clamp can't under-fill the page and terminate
    // pagination early; walk (createdAt DESC) rows collecting visible ones until
    // the page is full, then resume the keyset from the first fetched row we did
    // NOT consume (getAllCollections' cursor is inclusive).
    const OVERFETCH = limit * 4 + 1;
    const rows = await getAllCollections({
      input: {
        limit: OVERFETCH,
        cursor,
        query,
        sort,
        privacy: [CollectionReadConfiguration.Public],
      },
      // Evaluate as anonymous — NEVER pass the session user. Combined with the
      // explicit `privacy: [Public]`, the service's own clamp forces Public
      // UNCONDITIONALLY (even the moderator override can't widen), so the result
      // set is caller-independent and edge-cacheable.
      user: undefined,
      select: {
        id: true,
        name: true,
        description: true,
        read: true,
        type: true,
        nsfwLevel: true,
        userId: true,
        user: { select: { id: true, username: true } },
        image: { select: { url: true, type: true, nsfwLevel: true } },
      },
    });

    const visible: typeof rows = [];
    let firstUnconsumedId: number | undefined;
    for (let i = 0; i < rows.length; i++) {
      if (visible.length >= limit) {
        firstUnconsumedId = rows[i].id;
        break;
      }
      if (withinCeiling(rows[i].nsfwLevel ?? 0, browsingLevel)) visible.push(rows[i]);
    }

    let nextCursor: number | undefined;
    if (firstUnconsumedId !== undefined) nextCursor = firstUnconsumedId;
    else if (rows.length === OVERFETCH) nextCursor = rows[rows.length - 1]?.id;

    const ids = visible.map((c) => c.id);
    const countRows = await getCollectionItemCount({
      collectionIds: ids,
      status: CollectionItemStatus.ACCEPTED,
    });
    const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

    const items: CollectionListItem[] = visible.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      type: c.type ?? null,
      nsfwLevel: c.nsfwLevel ?? null,
      read: c.read,
      isPublic: c.read === CollectionReadConfiguration.Public,
      itemCount: countMap.get(c.id) ?? 0,
      coverImageUrl: coverUrl(c.image),
      user: { id: c.user?.id ?? c.userId ?? null, username: c.user?.username ?? null },
    }));

    const nextCursorStr = nextCursor !== undefined ? String(nextCursor) : undefined;
    const { nextPage } = getNextPage({ req, nextCursor: nextCursorStr });
    return res
      .status(200)
      .json({ items, metadata: { nextCursor: nextCursor ?? undefined, nextPage } });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
