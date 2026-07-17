import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';

import { getArticleById } from '~/server/services/article.service';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';

/**
 * GET /api/v1/articles/[id] — public article detail.
 *
 * Wraps the EXISTING `getArticleById` service (the same one `articleRouter.getById`
 * uses). Visibility is enforced server-side: for a non-moderator it matches
 * `(publishedAt IS NOT NULL AND status = Published AND ingestion = Scanned) OR
 * userId = <session user>`. So a draft / unpublished / not-yet-scanned article is
 * reachable ONLY by its owner (authenticated) or a moderator; everyone else gets a
 * 404. Ownership comes solely from the authenticated session — never a client
 * param. A private article a non-owner requests is INDISTINGUISHABLE from a
 * non-existent one (both 404), so this is not an existence oracle.
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
  // App Blocks author-cohort gate — DARK preview, cohort-only (mods + the
  // `app-blocks-author` Flipt cohort). Anonymous / non-cohort → bare 404 (no
  // existence oracle), evaluated before the rate limit + service.
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    return res.status(404).json({ error: 'Not found' });
  }

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

  try {
    const article = await getArticleById({
      id,
      userId: user?.id,
      isModerator: user?.isModerator,
    });

    // moderatorNsfwLevel is a moderator-only override the service includes for the
    // edit form; strip it so it never leaks through the public REST payload.
    const { moderatorNsfwLevel, ...publicArticle } = article;

    return res.status(200).json(publicArticle);
  } catch (e) {
    // getArticleById throws NOT_FOUND for a missing / non-visible article →
    // handleEndpointError maps it to a 404.
    return handleEndpointError(res, e);
  }
});
