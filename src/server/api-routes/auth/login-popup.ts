import type { NextApiRequest, NextApiResponse } from 'next';
import { buildHubLoginRedirect } from '~/server/auth/login-redirect';
import { resolveSelfOrigin, safePath } from '~/server/auth/oauth-bridge';

// GET /api/auth/login-popup?cb=<same-origin path>&reason=<reason> — the POPUP login entry, server-side. Builds
// the hub login URL with the server's AUTH_JWT_ISSUER (no client hub env var) whose post-login dest is the
// same-origin /login/popup-done page (which signals the opener via BroadcastChannel + sends the email
// magic-link tab back to `cb`), and 302s to it. The full-page login path uses /login; this exists separately
// because /login's loop-guard would collapse the /login/popup-done dest.
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB) {
    res.status(500).json({ error: 'hub not configured' });
    return;
  }
  const selfOrigin = resolveSelfOrigin(req);
  if (!selfOrigin) {
    res.status(500).json({ error: 'self origin not resolvable' });
    return;
  }

  const cb = safePath(req.query.cb); // where the originating tab returns after login (same-origin only)
  const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
  const dest = `/login/popup-done?cb=${encodeURIComponent(cb)}`;
  res.redirect(302, buildHubLoginRedirect({ origin: selfOrigin, hubIssuer: HUB, dest, reason }));
}
