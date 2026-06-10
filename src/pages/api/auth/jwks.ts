import type { NextApiRequest, NextApiResponse } from 'next';
import { maybeCreateSessionSigner } from '@civitai/auth';

// Public JWKS endpoint — spokes fetch + cache the hub's RS256 public key(s) from here to
// verify session tokens locally (Path C). Returns 404 until the hub keys are configured.
// Exposed at /.well-known/jwks.json via a rewrite in next.config.mjs (this route is the target).
const signer = maybeCreateSessionSigner();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!signer) return res.status(404).json({ error: 'JWKS not configured' });
  const jwks = await signer.publicJwks();
  // Public keys are cacheable; rotation publishes a new kid before retiring the old.
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  return res.status(200).json(jwks);
}
