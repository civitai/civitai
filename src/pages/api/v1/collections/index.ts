import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { CollectionSort } from '~/server/common/enums';
import {
  getAllCollections,
  getCollectionItemCount,
  getUserCollectionsWithPermissions,
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
 * GET /api/v1/collections — public list/search over collections.
 *
 * Two modes, both wrapping EXISTING services (no reimplemented business logic):
 *   - default (public): `getAllCollections`, whose privacy is PINNED to
 *     `[Public]` for any non-moderator caller (the service forces this itself),
 *     so an unauthenticated caller only ever sees Public collections.
 *   - `mine=true` (authenticated only → 401 otherwise): the caller's OWN
 *     collections via `getUserCollectionsWithPermissions`, keyed on the SESSION
 *     user id — never a client-supplied userId.
 *
 * A private collection is therefore unreachable here for a non-owner. Maturity is
 * clamped to the region-narrowed browsing ceiling (a collection / cover above the
 * ceiling is dropped or its cover nulled), matching the other public endpoints.
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
  mine: booleanString().optional().default(false),
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
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'collections', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsedParams = collectionsEndpointSchema.safeParse(req.query);
  if (!parsedParams.success) return res.status(400).json({ error: parsedParams.error });

  const { limit, cursor, query, sort, mine, nsfw } = parsedParams.data;

  if (mine && !user) return res.status(401).json({ error: 'Unauthorized' });

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
    if (mine && user) {
      // Own collections. The service returns the full owned set (no DB paging);
      // apply the name filter + keyset (id DESC) slice in-memory. A user's own
      // collection set is bounded.
      const owned = await getUserCollectionsWithPermissions({
        input: { userId: user.id, contributingOnly: true },
      });

      const needle = query?.toLowerCase();
      const filtered = owned
        .filter((c) => (needle ? c.name.toLowerCase().includes(needle) : true))
        .filter((c) => (cursor ? c.id < cursor : true))
        .sort((a, b) => b.id - a.id);

      let page = filtered;
      let nextCursor: number | undefined;
      if (page.length > limit) {
        page = page.slice(0, limit);
        nextCursor = page[page.length - 1]?.id;
      }

      const ids = page.map((c) => c.id);
      const countRows = await getCollectionItemCount({
        collectionIds: ids,
        status: CollectionItemStatus.ACCEPTED,
      });
      const countMap = new Map(countRows.map((c) => [c.id, Number(c.count)]));

      const items: CollectionListItem[] = page.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description ?? null,
        type: c.type ?? null,
        nsfwLevel: null,
        read: c.read,
        isPublic: c.read === CollectionReadConfiguration.Public,
        itemCount: countMap.get(c.id) ?? 0,
        coverImageUrl: coverUrl(
          c.image
            ? { url: c.image.url, type: c.image.type, nsfwLevel: c.image.nsfwLevel }
            : null
        ),
        user: { id: user.id, username: user.username ?? null },
      }));

      const nextCursorStr = nextCursor !== undefined ? String(nextCursor) : undefined;
      const { nextPage } = getNextPage({ req, nextCursor: nextCursorStr });
      return res
        .status(200)
        .json({ items, metadata: { nextCursor: nextCursor ?? undefined, nextPage } });
    }

    // Public discovery. Over-fetch so the maturity clamp can't under-fill the page
    // and terminate pagination early; walk (createdAt DESC) rows collecting visible
    // ones until the page is full, then resume the keyset from the first fetched row
    // we did NOT consume (getAllCollections' cursor is inclusive).
    const OVERFETCH = limit * 4 + 1;
    const rows = await getAllCollections({
      input: {
        limit: OVERFETCH,
        cursor,
        query,
        sort,
        privacy: [CollectionReadConfiguration.Public],
      },
      user,
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
