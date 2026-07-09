import { json, error } from '@sveltejs/kit';
import { maybeCreateSessionSigner } from '@civitai/auth';
import type { RequestHandler } from './$types';

// Standard discovery path. SvelteKit serves dotted route segments fine, so unlike the Next
// app no rewrite is needed here — `.well-known/jwks.json` resolves directly.
const signer = maybeCreateSessionSigner();

export const GET: RequestHandler = async () => {
  if (!signer) error(404, 'JWKS not configured');
  const jwks = await signer.publicJwks();
  return json(jwks, {
    headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=86400' },
  });
};
