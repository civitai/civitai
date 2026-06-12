import type { NextApiRequest, NextApiResponse } from 'next';
import { maybeCreateSessionSigner } from '@civitai/auth';

// Public JWKS endpoint — spokes fetch + cache this app's ES256 public key(s) from here to verify
// id_tokens / session tokens locally (Path C). Returns 404 until the keys are configured. This is
// the canonical path: the OIDC discovery doc advertises `jwks_uri: /api/auth/jwks` directly, so no
// /.well-known rewrite is needed (the SvelteKit hub additionally serves /.well-known/jwks.json).
const signer = maybeCreateSessionSigner();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!signer) return res.status(404).json({ error: 'JWKS not configured' });
  const jwks = await signer.publicJwks();
  // Public keys are cacheable; rotation publishes a new kid before retiring the old.
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  return res.status(200).json(jwks);
}
