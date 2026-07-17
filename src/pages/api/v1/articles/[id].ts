import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getArticleById } from '~/server/services/article.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

/**
 * GET /api/v1/articles/[id] — public, edge-cacheable article detail.
 *
 * Wraps the EXISTING `getArticleById` service (the same one `articleRouter.getById`
 * — a public procedure — uses for anonymous website visitors). This endpoint
 * evaluates as anonymous ALWAYS (no `userId`/`isModerator` passed), so the service
 * matches `publishedAt IS NOT NULL AND status = Published AND ingestion = Scanned`
 * for EVERY caller: a draft / unpublished / not-yet-scanned article is a 404 for
 * everyone, authed or not. There is no owner self-view branch here, so the
 * response is a pure function of the id (+ region) — byte-identical for an
 * anonymous caller and any authenticated caller — which makes the
 * `MixedAuthEndpoint` wrapper's `public, s-maxage=300` edge caching safe. A
 * private article is INDISTINGUISHABLE from a non-existent one (both 404), so this
 * is not an existence oracle.
 *
 * Maturity: the cover image is clamped to the region-narrowed PUBLIC browsing
 * ceiling (the SAME default the list endpoint uses, `publicBrowsingLevelsFlag`
 * narrowed to `sfwBrowsingLevelsFlag` for restricted regions) — a cover above the
 * ceiling is dropped so an anonymous SFW caller never receives mature cover art.
 * `getArticleById` takes no browsing-level param, so the clamp is applied here as
 * a post-service filter. It is derived ONLY from the region (`cf-ipcountry`) — it
 * NEVER reads the caller's nsfw preference / browsingLevel cookie / session — so
 * the response stays a pure function of id + region and remains edge-cacheable.
 */

// Bound the coerced id to Postgres int4 (mirrors models/[id].ts): a huge numeric
// string would otherwise bind to the int4 `Article.id` and throw a raw PG range
// 500. `.int().gt(0)` also rejects non-integer / non-positive ids.
export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Conservative per-client rate limit (before the service call). Keys on
  // CF-Connecting-IP / userId — guards only the cache-MISS path; the response
  // body itself never varies by user.
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'articles', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
  }

  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success)
    return res.status(400).json({ error: z.prettifyError(parsedParams.error) ?? 'Invalid id' });

  const { id } = parsedParams.data;

  // Maturity/region ceiling — the SAME fixed PUBLIC default the list endpoint
  // uses (articles/index.ts), narrowed to SFW for restricted regions. Region-
  // derived ONLY (from `cf-ipcountry`); it NEVER reads the caller's nsfw
  // preference/cookie/session, so the response stays a pure function of id +
  // region and the `public` edge cache is leak-free.
  const region = getRegion(req);
  let browsingLevel = publicBrowsingLevelsFlag;
  if (isRegionRestricted(region)) browsingLevel = sfwBrowsingLevelsFlag;

  try {
    // Evaluate as anonymous — NEVER pass the session userId/isModerator. This
    // pins published-only visibility for every caller (no owner-draft branch), so
    // the response is caller-independent and edge-cacheable.
    const article = await getArticleById({ id });

    // moderatorNsfwLevel is a moderator-only override the service includes for the
    // edit form; strip it so it never leaks through the public REST payload.
    const { moderatorNsfwLevel, ...publicArticle } = article;

    // Clamp the cover image to the region-narrowed public ceiling: drop a cover
    // whose nsfwLevel is above the ceiling (mirroring the service's own
    // "not viewable → coverImage: undefined" semantics) so an anon SFW caller
    // never gets mature cover art. A level of 0 (unrated) is always allowed;
    // otherwise it must intersect the clamped browsing level (the same bitwise
    // test the list / collections endpoints use). Applied ONLY to a present
    // cover, so an article with no viewable cover keeps its existing shape.
    if (
      publicArticle.coverImage?.nsfwLevel &&
      !Flags.intersects(publicArticle.coverImage.nsfwLevel, browsingLevel)
    ) {
      publicArticle.coverImage = undefined;
    }

    return res.status(200).json(publicArticle);
  } catch (e) {
    // getArticleById throws NOT_FOUND for a missing / non-visible article →
    // handleEndpointError maps it to a 404.
    return handleEndpointError(res, e);
  }
});
