import { mintSearchToken } from '~/server/meilisearch/search-token';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';

// The token's rules come from the session alone; nothing in the request can widen them.
export default MixedAuthEndpoint(async function handler(_req, res, user) {
  res.setHeader('Cache-Control', 'private, no-store');
  const minted = mintSearchToken(user);
  return res.status(200).json(minted ?? { token: null });
});
