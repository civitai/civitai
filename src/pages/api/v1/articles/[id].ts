import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getArticleById } from '~/server/services/article.service';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { articleContentJson } from '~/server/utils/article-content-json';
import { removeBodyMedia, servableBodyImageUrls } from '~/server/utils/article-body-media';
import { relatedPostsBrowsingLevel } from '~/server/utils/browsing-level';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { withPublicAvatar } from '~/server/utils/public-avatar';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { isArticleServableWhenRestricted } from '~/server/utils/article-region';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * GET /api/v1/articles/[id] — public article detail.
 *
 * Wraps the EXISTING `getArticleById` service (the same one `articleRouter.getById`
 * — a public procedure — uses for anonymous website visitors). This endpoint
 * evaluates as anonymous ALWAYS (no `userId`/`isModerator` passed), so the service
 * matches `publishedAt IS NOT NULL AND status = Published AND ingestion = Scanned`
 * for EVERY caller: a draft / unpublished / not-yet-scanned article is a 404 for
 * everyone, authed or not. There is no owner self-view branch here. It is
 * `private, no-store` for every caller: the body depends on the caller's region and level.
 * Outside a restricted region the article body follows the article's own level, so it can be
 * above SFW; the cover, banner and author avatar are clamped to PG, or PG|PG13 in a restricted
 * region. A private article is INDISTINGUISHABLE from a non-existent one (both 404), so this is
 * not an existence oracle.
 *
 * Maturity: in a restricted region, an article above SFW (its own level, or any connected image
 * in its body) is the same 404 as a missing one, as on `/api/v1/posts/[id]`. The cover image is
 * clamped to the region-narrowed PUBLIC browsing ceiling (the SAME default the list endpoint
 * uses, `publicBrowsingLevelsFlag`
 * narrowed to `sfwBrowsingLevelsFlag` for restricted regions) — a cover above the
 * ceiling is dropped so an anonymous SFW caller never receives mature cover art.
 * `getArticleById` takes no browsing-level param, so the clamp is applied here as
 * a post-service filter. It is derived ONLY from the region (`cf-ipcountry`) — it
 * NEVER reads the caller's nsfw preference / browsingLevel cookie / session — so
 * the cover, banner and avatar are a pure function of id + region.
 *
 * Body images and media (`content`, `contentJson`, `contentImages`) are the exception: they
 * are held to the caller's level, the public default when signed out, or an API key holder's own
 * level under the domain cap. Above it, or not servable to anyone (unscanned, awaiting review, a
 * violation), the node is dropped from the body, author included.
 */

// Bound the coerced id to Postgres int4 (mirrors models/[id].ts): a huge numeric
// string would otherwise bind to the int4 `Article.id` and throw a raw PG range
// 500. `.int().gt(0)` also rejects non-integer / non-positive ids.
export const schema = z.object({ id: z.coerce.number().int().gt(0).lte(2147483647) });

export default MixedAuthEndpoint(handler, ['GET'], { scope: { anyOf: [TokenScope.ArticlesRead] } });

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Conservative per-client rate limit (before the service call). Keys on
  // CF-Connecting-IP / userId.
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
  // preference/cookie/session. Body media is held separately, by `bodyBrowsingLevel`.
  const region = getRegion(req);
  const restricted = isRegionRestricted(region);
  const browsingLevel = restricted ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
  // The body depends on the caller's region and level, which the shared cache does not key on.
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    // Evaluate as anonymous — NEVER pass the session userId/isModerator. This
    // pins published-only visibility for every caller (no owner-draft branch).
    const article = await getArticleById({ id });
    // Answered as the same 404 as a missing article.
    if (restricted && !isArticleServableWhenRestricted(article))
      throw throwNotFoundError(`No article with id ${id}`);

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
      // The legacy `cover` is the same image's key.
      publicArticle.cover = null;
    }
    // The banner is the same kind of image, and stands in for a missing cover on cards.
    if (
      publicArticle.bannerImage?.nsfwLevel &&
      !Flags.intersects(publicArticle.bannerImage.nsfwLevel, browsingLevel)
    ) {
      publicArticle.bannerImage = undefined;
    }

    const bodyLevel = bodyBrowsingLevel(req, user, restricted);
    const bodyImages = publicArticle.contentImages ?? [];
    const servable = servableBodyImageUrls(bodyImages, bodyLevel);
    const withheld = bodyImages.map(({ url }) => url).filter((url) => !servable.has(url));
    const content =
      publicArticle.content && removeBodyMedia(publicArticle.content, { keep: servable, withheld });
    const contentJson = content ? articleContentJson(content) : undefined;
    // The page reads more of each content image to guard it; the documented payload keeps these three.
    const contentImages = publicArticle.contentImages
      ?.filter(({ url }) => servable.has(url))
      .map(({ id, url, ingestion }) => ({ id, url, ingestion }));

    const author = publicArticle.user && withPublicAvatar(publicArticle.user, browsingLevel);

    return res
      .status(200)
      .json({ ...publicArticle, user: author, content, contentJson, contentImages });
  } catch (e) {
    // getArticleById throws NOT_FOUND for a missing / non-visible article →
    // handleEndpointError maps it to a 404.
    return handleEndpointError(res, e);
  }
}

/** Signed out, the public default; with a key, the holder's own level under the domain cap. */
function bodyBrowsingLevel(
  req: NextApiRequest,
  user: Session['user'] | undefined,
  restricted: boolean
) {
  const features = getFeatureFlagsLazy({ user, req });
  const level = relatedPostsBrowsingLevel({ user, req, features }, undefined);
  return restricted ? level & sfwBrowsingLevelsFlag : level;
}
