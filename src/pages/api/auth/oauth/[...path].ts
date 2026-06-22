import type { NextApiRequest, NextApiResponse } from 'next';

// Legacy compatibility shim. The OAuth/OIDC provider moved to the hub (auth.civitai.com); the old
// civitai.com/api/auth/oauth/* endpoints were removed. Any third-party client still pinned to the old URLs
// is redirected here to the hub's equivalent path.
//
// 308 (Permanent Redirect) preserves the METHOD + BODY + query, so a single catch-all covers both the
// browser-facing `/authorize` (GET) and the server-to-server `/token`, `/userinfo`, `/revoke`, `device*`
// (POST). `req.url` is already `/api/auth/oauth/<path>?<query>` and the hub mirrors that exact path, so the
// target is just `${HUB}${req.url}`.
//
// NOTE: a 308 relies on the client following the redirect. Browsers (authorize) and well-behaved server
// HTTP libraries (token exchange) do; the rare OAuth lib that refuses to follow a redirect on the token
// endpoint would need a thin server-side proxy for `/token` instead — add that only if it actually bites.
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB || !req.url) {
    res.status(500).json({ error: 'server_error', error_description: 'OAuth hub not configured' });
    return;
  }
  res.redirect(308, `${HUB}${req.url}`);
}
