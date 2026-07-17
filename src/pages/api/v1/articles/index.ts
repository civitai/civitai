import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNextPage } from '~/server/utils/pagination-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

/**
 * GET /api/v1/articles — public list/search over articles.
 *
 * Wraps the EXISTING `getArticles` service (the same function that powers the
 * website's article feed via `articleRouter.getInfinite`). Visibility is enforced
 * server-side by that service: for a non-owner / non-moderator caller it returns
 * ONLY `status = Published` + `ingestion = Scanned` articles and drops
 * `availability = Private` ones. This endpoint NEVER passes a client-supplied
 * userId — ownership is derived solely from the authenticated session (`user`),
 * so an unauthenticated caller can only ever see published, public articles.
 *
 * Pagination: composite keyset cursor (the article feed can't use offset paging —
 * ranked sorts need the `(sortValue, id)` tiebreaker). The opaque `cursor` string
 * is `"<v>|<id>"`; the response returns the next one plus a ready-made `nextPage`
 * URL — matching the `{ items, metadata: { nextCursor, nextPage } }` envelope the
 * other public v1 endpoints use.
 */

export const config = {
  api: {
    responseLimit: false,
  },
};

// favorites/hidden surface the CALLER's OWN engagement — meaningless (and gated
// inside getArticles behind `if (sessionUser)`) without a session, so we 401 if
// an unauthenticated caller requests them (mirrors models/index.ts).
const authedOnlyOptions = ['favorites', 'hidden'] as const;

const articlesEndpointSchema = z.object({
  limit: z.preprocess((val) => Number(val), z.number().min(1).max(100)).default(100),
  cursor: z.string().max(100).optional(),
  query: z.string().optional(),
  sort: z.enum(ArticleSort).optional(),
  tags: commaDelimitedNumberArray().optional(),
  username: z.string().optional(),
  favorites: booleanString().optional().default(false),
  hidden: booleanString().optional().default(false),
  nsfw: booleanString().optional(),
});

// Parse the opaque "<v>|<id>" REST cursor back into the service's composite
// keyset cursor. `null` = malformed (→ clean 400); `undefined` = absent.
function parseArticleCursor(
  cursor: string | undefined
): { v: number; id: number } | null | undefined {
  if (!cursor) return undefined;
  const parts = cursor.split('|');
  if (parts.length !== 2) return null;
  const v = Number(parts[0]);
  const id = Number(parts[1]);
  if (!Number.isFinite(v) || !Number.isInteger(id)) return null;
  return { v, id };
}

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Conservative per-client rate limit (before the expensive service call).
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'articles', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  if (Object.keys(req.query).some((key) => (authedOnlyOptions as readonly string[]).includes(key)) && !user)
    return res.status(401).json({ error: 'Unauthorized' });

  const parsedParams = articlesEndpointSchema.safeParse(req.query);
  if (!parsedParams.success) return res.status(400).json({ error: parsedParams.error });

  const { limit, cursor, query, sort, tags, username, favorites, hidden, nsfw } = parsedParams.data;

  const parsedCursor = parseArticleCursor(cursor);
  if (parsedCursor === null) return res.status(400).json({ error: 'Invalid cursor' });

  // Maturity/region ceiling — identical derivation to models/index.ts.
  const region = getRegion(req);
  let browsingLevel = !nsfw ? publicBrowsingLevelsFlag : allBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  try {
    const { items, nextCursor } = await getArticles({
      limit,
      cursor: parsedCursor,
      query,
      tags,
      username,
      favorites,
      hidden,
      // AllTime + published: getArticles requires a defined period/periodMode; this
      // pins the extra `publishedAt IS NOT NULL AND status = Published` guard on top
      // of the service's own non-owner visibility gate.
      period: MetricTimeframe.AllTime,
      periodMode: 'published',
      sort: sort ?? ArticleSort.Newest,
      browsingLevel,
      sessionUser: user,
      include: [],
      // Public scriptable surface: NEVER expand to `availability = Private`
      // articles, even when `?username=` is set (which normally lifts the
      // private-drop for owner self-views). Conservative-by-default.
      forceHidePrivate: true,
    });

    const nextCursorStr = nextCursor ? `${nextCursor.v}|${nextCursor.id}` : undefined;
    const { nextPage } = getNextPage({ req, nextCursor: nextCursorStr });

    return res.status(200).json({ items, metadata: { nextCursor: nextCursorStr, nextPage } });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
