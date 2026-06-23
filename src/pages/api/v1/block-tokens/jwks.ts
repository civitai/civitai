import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { env } from '~/env/server';
import { isAppBlocksRuntimeEnabled } from '~/server/services/app-blocks-flag';
import { BlockTokenService } from '~/server/services/block-token.service';

/**
 * GET /api/v1/block-tokens/jwks
 *
 * Serves the RSA public key(s) in JWKS format for block-token verification.
 *
 * Cache window is intentionally short (60s) and an ETag is set on the body so
 * intermediates revalidate quickly. The previous 300s window was too long for
 * the rotation story: a verifier holding the old JWKS could fail a signature
 * from a freshly-rotated _NEXT key for up to five minutes.
 */
export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!env.BLOCK_TOKEN_PUBLIC_KEY) {
    res.status(503).json({ error: 'Block tokens not configured' });
    return;
  }
  // Decision 4: gate the public-key surface on the dedicated GLOBAL runtime
  // flag (`app-blocks-runtime-enabled`) rather than the global eval of the
  // mod-segmented user flag (which could never resolve true without a user
  // context, leaving JWKS permanently dark even after deploys were lit). The
  // runtime flag is the "block-JWT verification subsystem is active" switch; it
  // is decoupled from the build pipeline flag so pausing builds doesn't kill
  // verification. Fail-safe: absent flag / Flipt-down → false → 503 (same dark
  // behaviour as before — no widening, since unauthorized callers never hold a
  // block JWT to verify in the first place).
  if (!(await isAppBlocksRuntimeEnabled())) {
    res.status(503).json({ error: 'App Blocks not enabled' });
    return;
  }
  // L-4: surface a 503 (configuration error) on malformed-key boot
  // instead of a generic 500. The unconfigured case is already 503 above;
  // this catches the case where the env vars are set but malformed.
  let body: ReturnType<typeof BlockTokenService.getJwks>;
  try {
    body = BlockTokenService.getJwks();
  } catch {
    res.status(503).json({ error: 'Block token keys are misconfigured' });
    return;
  }
  const serialized = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(serialized).digest('base64url').slice(0, 22)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(serialized);
});
