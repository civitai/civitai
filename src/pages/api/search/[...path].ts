import type { NextApiRequest } from 'next';
import { restModeratorViewer, restOwnerOrModeratorViewer } from '~/server/auth/rest-viewer';
import type * as z from 'zod';
import {
  siteFacetSearchSchema,
  siteMultiSearchSchema,
  siteSearchParamsSchema,
} from '~/server/schema/site-search.schema';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import type {
  SiteSearchOptions,
  SiteSearchUpstream,
  SiteSearchViewer,
} from '~/server/services/site-search.service';
import { isSiteSearchPassthroughOn } from '~/server/services/site-search-passthrough';
import {
  collectionImageLevelFor,
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
import { isProfaneSearch, siteSearchQueries } from '~/server/services/profanity-list.service';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  beginFeedGoShadowSiteSearch,
  captureFeedGoShadowSiteSearch,
  finishFeedGoShadow,
} from '~/server/trpc/feed-go-shadow';

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

/**
 * What the handler reads from outside the request: the rate limit, the host's features, the
 * profanity verdict, the passthrough switch and the feed-go shadow sampler. The route uses the real
 * ones; a test passes its own (the feed-go golden fixtures answer each from the fixture, and build a
 * sampler with the flag on whose POST to feed-go they observe).
 */
export type SiteSearchRouteDeps = {
  checkRateLimit: typeof checkSiteSearchRateLimit;
  getFeatures: typeof getFeatureFlagsLazy;
  isProfane: typeof isProfaneSearch;
  isPassthroughOn: typeof isSiteSearchPassthroughOn;
  shadow: {
    begin: typeof beginFeedGoShadowSiteSearch;
    capture: typeof captureFeedGoShadowSiteSearch;
    finish: typeof finishFeedGoShadow;
  };
};

const siteSearchRouteDeps: SiteSearchRouteDeps = {
  checkRateLimit: checkSiteSearchRateLimit,
  getFeatures: getFeatureFlagsLazy,
  isProfane: isProfaneSearch,
  isPassthroughOn: isSiteSearchPassthroughOn,
  shadow: {
    begin: beginFeedGoShadowSiteSearch,
    capture: captureFeedGoShadowSiteSearch,
    finish: finishFeedGoShadow,
  },
};

/** The route's handler, below the session: `user` is the session's user, or undefined. */
export function createSiteSearchHandler(
  deps: SiteSearchRouteDeps = siteSearchRouteDeps
): Parameters<typeof MixedAuthEndpoint>[0] {
  return async function handler(req, res, user) {
    // `/api/search` is outside the proxy matcher, so the policy runs here.
    if (applyApiRequestPolicy(req as NextApiRequest, res)) return;
    // The answer depends on the session and the host, so nothing may cache it.
    res.setHeader('Cache-Control', 'private, no-store');

    const rateLimit = await deps.checkRateLimit({
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

    const features = deps.getFeatures({ user, req });
    // civitai.com refuses a profane search. Verdict only: the response never names the words.
    if (features.isGreen && (await deps.isProfane(siteSearchQueries(req.body))))
      return res.status(422).json({
        message: 'This search is not allowed.',
        code: SEARCH_REFUSED_CODE,
        type: 'invalid_request',
      });
    const isModerator = restModeratorViewer(req, user)?.isModerator;
    const browsingLevelCap = requestDomainBrowsingLevelCap({
      user,
      features,
      req: req as NextApiRequest,
    });
    const viewer: SiteSearchViewer = {
      userId: restOwnerOrModeratorViewer(req, user)?.id,
      isModerator,
      browsingLevelCap,
      collectionImageLevel: collectionImageLevelFor({
        browsingLevelCap,
        signedIn: !!user,
        isModerator,
        viewerBrowsingLevel: getRequestBrowsingLevel({ features, user }),
      }),
      showSfwFace: !Flags.intersects(
        getRequestBrowsingLevel({ features, user }),
        nsfwBrowsingLevelsFlag
      ),
    };

    // The feed-go shadow (default off): decided after the cheap rejects above; a sampled request
    // keeps the search call and the backend's answer for the mirror, sent after the response.
    const sample = deps.shadow.begin(req as NextApiRequest);
    const observed: { upstream?: SiteSearchUpstream } = {};
    try {
      const { status, body, raw } = await route([req.query.path ?? []].flat(), req.body, viewer, {
        passthrough: deps.isPassthroughOn(),
        ...(sample
          ? {
              onUpstream: (call: SiteSearchUpstream) => {
                observed.upstream = call;
              },
            }
          : {}),
      });
      if (sample && status === 200 && observed.upstream)
        deps.shadow.capture(sample, { ...observed.upstream, raw, body });
      if (raw) {
        // Meilisearch's own JSON, unparsed: the same content type `res.json` would set.
        // Written with `res.end`: Next's `res.send` JSON.stringifies a Buffer to hash its ETag.
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', raw.length);
        res.status(status);
        return res.end(raw);
      }
      return res.status(status).json(body);
    } catch (error) {
      if (!(error instanceof SiteSearchError)) throw error;
      if (error.retryAfterSeconds !== undefined)
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(error.status).json(error.toResponseBody());
    } finally {
      if (sample) deps.shadow.finish(sample, res.statusCode, res);
    }
  };
}

/**
 * @ported-to-go feed-go · status: shadow · see ports/manifest.json (id: POST /api/search/[...path]).
 * Changing this behaviour? Update apps/feed-go/internal/server/sitesearch.go, apps/feed-go/internal/sitesearch/serve.go in the same PR; CI lists every port a PR touches.
 * Generated by `node scripts/ports/generate.mjs` from ports/manifest.json: edit the manifest, not this block.
 */
export default MixedAuthEndpoint(createSiteSearchHandler(), ['POST']);
