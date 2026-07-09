import { json, error } from '@sveltejs/kit';
import { maybeCreateSessionSigner } from '@civitai/auth';
import type { RequestHandler } from './$types';

// Public keys for verifying session JWTs (first-party spokes) and OIDC id_tokens (third
// parties). 404 until the hub ES256 keys are configured.
const signer = maybeCreateSessionSigner();

export const GET: RequestHandler = async () => {
  if (!signer) error(404, 'JWKS not configured');
  const jwks = await signer.publicJwks();
  return json(jwks, {
    headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=86400' },
  });
};
