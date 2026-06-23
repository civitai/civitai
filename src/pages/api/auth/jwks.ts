import type { NextApiRequest, NextApiResponse } from 'next';

// Legacy JWKS shim. The token-signing keys live on the hub now (auth.civitai.com); this app is verify-only
// and no longer holds the private key, so it can't publish a JWKS itself. Any client still pinned to the old
// civitai.com JWKS (e.g. a legacy OIDC RP that derived `jwks_uri` from a civitai.com issuer, or a service
// with AUTH_JWKS_URI pointed here) is 308-redirected to the hub's canonical JWKS. New integrations use the
// hub directly (the OIDC discovery doc advertises the hub's jwks_uri). 308 preserves the GET + query.
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) {
    res.status(500).json({ error: 'server_error', error_description: 'OAuth hub not configured' });
    return;
  }
  res.redirect(308, `${HUB}/api/auth/jwks`);
}
