import type { NextApiRequest, NextApiResponse } from 'next';

// Legacy OIDC discovery shim. The OAuth/OIDC provider moved to the hub (auth.civitai.com); the old
// civitai.com discovery doc was removed. A legacy relying party still pinned to the civitai.com issuer
// fetches discovery here (the edge maps the public /.well-known/openid-configuration to this api route, as
// it did pre-migration); 308-redirect it to the hub's canonical discovery, which advertises the hub's
// authorization/token/userinfo/revoke/device + jwks endpoints. New integrations point at auth.civitai.com
// directly. Sibling of src/pages/api/auth/oauth/[...path].ts, which forwards the protocol endpoints.
//
// NOTE: the hub's `issuer` is auth.civitai.com, so an RP that STRICTLY validates `iss`/`id_token.iss`
// against the old civitai.com issuer must update its configured issuer — forwarding fixes transport (the
// client reaches the hub's endpoints), not the issuer identity. See docs/auth/oauth-security-review-2026-06-22.md.
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) {
    res.status(500).json({ error: 'server_error', error_description: 'OAuth hub not configured' });
    return;
  }
  res.redirect(308, `${HUB}/.well-known/openid-configuration`);
}
