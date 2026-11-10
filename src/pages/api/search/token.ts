import { mintSearchToken } from '~/server/meilisearch/search-token';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';

// The token's rules come from the session and the host; nothing in the request can widen them.
export default MixedAuthEndpoint(async function handler(req, res, user) {
  // `/api/search` is outside the proxy matcher, so the policy runs here.
  if (applyApiRequestPolicy(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  const features = getFeatureFlagsLazy({ user, req });
  const browsingLevelCap = requestDomainBrowsingLevelCap({ user, features, req }) ?? null;
  const minted = mintSearchToken({
    id: user?.id,
    isModerator: user?.isModerator,
    browsingLevelCap,
  });
  return res.status(200).json(minted ?? { token: null });
});
