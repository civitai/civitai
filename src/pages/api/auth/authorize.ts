import type { NextApiRequest, NextApiResponse } from 'next';
import {
  resolveSelfOrigin,
  buildAuthorizeRedirect,
  safePath,
  HUB_BASE_URL,
} from '~/server/auth/oauth-bridge';

// GET /api/auth/authorize — INITIATE first-party cross-domain login. A spoke on a different registrable domain
// (civitai.red / a test host / localhost) can't read the hub's `.civitai.com` cookie, so it runs the OAuth
// authorization-code + PKCE flow against the hub. This is a THIN Next wrapper: derive this spoke's origin, then
// the package bridge builds the hub /authorize URL (first-party client_id + exact redirect_uri + state + S256
// challenge) and the bridge cookie (PKCE verifier + state + returnUrl, for /api/auth/callback). The bridge core
// lives in @civitai/auth (first-party-bridge) — shared with every spoke + unit-tested there.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB_BASE_URL) {
    res.status(500).json({ error: 'hub not configured' });
    return;
  }
  const selfOrigin = resolveSelfOrigin(req);
  if (!selfOrigin) {
    res.status(500).json({ error: 'self origin not resolvable' });
    return;
  }
  const { location, setCookie } = buildAuthorizeRedirect({
    selfOrigin,
    returnUrl: safePath(req.query.returnUrl),
  });
  res.setHeader('Set-Cookie', setCookie);
  res.redirect(302, location);
}
