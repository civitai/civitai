import type { NextApiRequest } from 'next';
import type * as z from 'zod';
import {
  siteFacetSearchSchema,
  siteMultiSearchSchema,
  siteSearchParamsSchema,
} from '~/server/schema/site-search.schema';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import type { SiteSearchOptions, SiteSearchViewer } from '~/server/services/site-search.service';
import { isSiteSearchPassthroughOn } from '~/server/services/site-search-passthrough';
import {
  SiteSearchError,
  siteFacetSearch,
  siteIndexSearch,
  siteMultiSearch,
} from '~/server/services/site-search.service';
import {
  getRequestBrowsingLevel,
  requestDomainBrowsingLevelCap,
} from '~/server/utils/browsing-level';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { checkSiteSearchRateLimit } from '~/server/utils/site-search-rate-limit';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * The site's search UI speaks the Meilisearch protocol to this route instead of to Meilisearch:
 * `multi-search`, `indexes/:uid/search` and `indexes/:uid/facet-search`. Everything that scopes a
 * query comes from the session and the host, never from the request body.
 */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new SiteSearchError(400, 'invalid_search_request', result.error.issues[0].message);
  return result.data;
}

// The request body is always parsed against these schemas, passthrough or not: they strip every
// key the site's UI does not send (vector search, ranking details, federation), and the viewer's
// filter clauses are built on the parsed value. Passthrough skips only re-encoding the RESPONSE.
function route(
  path: string[],
  body: unknown,
  viewer: SiteSearchViewer,
  options: SiteSearchOptions
) {
  if (path.length === 1 && path[0] === 'multi-search')
    return siteMultiSearch(parse(siteMultiSearchSchema, body), viewer, options);
  if (path.length === 3 && path[0] === 'indexes') {
    const [, indexUid, action] = path;
    if (action === 'search')
      return siteIndexSearch(indexUid, parse(siteSearchParamsSchema, body), viewer, options);
    if (action === 'facet-search')
      return siteFacetSearch(indexUid, parse(siteFacetSearchSchema, body), viewer, options);
  }
  throw new SiteSearchError(404, 'not_found', 'Not found');
}

export default MixedAuthEndpoint(
  async function handler(req, res, user) {
    // `/api/search` is outside the proxy matcher, so the policy runs here.
    if (applyApiRequestPolicy(req as NextApiRequest, res)) return;
    // The answer depends on the session and the host, so nothing may cache it.
    res.setHeader('Cache-Control', 'private, no-store');

    const rateLimit = await checkSiteSearchRateLimit({
      req: req as NextApiRequest,
      userId: user?.id,
    });
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        message: 'Too many searches. Try again in a moment.',
        code: 'too_many_requests',
        type: 'invalid_request',
      });
    }

    const features = getFeatureFlagsLazy({ user, req });
    const viewer: SiteSearchViewer = {
      userId: user?.id,
      isModerator: user?.isModerator,
      browsingLevelCap: requestDomainBrowsingLevelCap({
        user,
        features,
        req: req as NextApiRequest,
      }),
      showSfwFace: !Flags.intersects(
        getRequestBrowsingLevel({ features, user }),
        nsfwBrowsingLevelsFlag
      ),
    };

    try {
      const { status, body, raw } = await route([req.query.path ?? []].flat(), req.body, viewer, {
        passthrough: isSiteSearchPassthroughOn(),
      });
      if (raw) {
        // Meilisearch's own JSON, unparsed: the same content type `res.json` would set.
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(status).send(raw);
      }
      return res.status(status).json(body);
    } catch (error) {
      if (!(error instanceof SiteSearchError)) throw error;
      if (error.retryAfterSeconds !== undefined)
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(error.status).json(error.toResponseBody());
    }
  },
  ['POST']
);
