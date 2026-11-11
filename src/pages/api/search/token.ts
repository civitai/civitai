import { mintSearchToken } from '~/server/meilisearch/search-token';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { checkSiteSearchRateLimit } from '~/server/utils/site-search-rate-limit';

// The token's rules come from the session and the host; nothing in the request can widen them.
// A viewer the site caps gets no token: their search goes through `/api/search`, which shapes
// hits (nested images included) as well as filtering them.
export default MixedAuthEndpoint(async function handler(req, res, user) {
  // `/api/search` is outside the proxy matcher, so the policy runs here.
  if (applyApiRequestPolicy(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  const rateLimit = await checkSiteSearchRateLimit({ req, userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({
      message: 'Too many searches. Try again in a moment.',
      code: 'too_many_requests',
      type: 'invalid_request',
    });
  }

  const features = getFeatureFlagsLazy({ user, req });
  if (requestDomainBrowsingLevelCap({ user, features, req }) !== undefined)
    return res.status(200).json({ token: null });

  const minted = mintSearchToken({
    id: user?.id,
    isModerator: user?.isModerator,
    browsingLevelCap: null,
  });
  return res.status(200).json(minted ?? { token: null });
});
