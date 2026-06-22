import type { NextApiRequest, NextApiResponse } from 'next';
import { setSessionCookie, postLoginMarkerCookie } from '~/server/auth/civ-cookie';
import {
  resolveSelfOrigin,
  completeFirstPartyCallback,
  clearBridgeCookie,
  OAUTH_BRIDGE_COOKIE,
  HUB_BASE_URL,
} from '~/server/auth/oauth-bridge';

// GET /api/auth/callback — RECEIVE the hub's authorization-code redirect. A THIN Next wrapper over the package
// bridge: verify `state` against the bridge cookie + exchange the code for a civ-token SESSION at the hub's
// first-party /session endpoint (server-to-server with the PKCE verifier), then set THIS domain's civ-token
// cookie via setSessionCookie() and continue to returnUrl. The CSRF/exchange logic lives in @civitai/auth
// (first-party-bridge). Cookie format is unchanged → existing sessions unaffected.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Don't leak the code/state in the inbound URL onward via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (!HUB_BASE_URL) {
    res.status(500).json({ error: 'hub not configured' });
    return;
  }
  const selfOrigin = resolveSelfOrigin(req);
  if (!selfOrigin) {
    res.status(500).json({ error: 'self origin not resolvable' });
    return;
  }

  // Single-use clear of the bridge cookie regardless of outcome (setSessionCookie appends to this on success).
  res.setHeader('Set-Cookie', clearBridgeCookie());

  const result = await completeFirstPartyCallback({
    selfOrigin,
    query: {
      code: typeof req.query.code === 'string' ? req.query.code : null,
      state: typeof req.query.state === 'string' ? req.query.state : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    },
    bridgeCookieValue: req.cookies[OAUTH_BRIDGE_COOKIE],
  });

  if ('error' in result) {
    res.redirect(302, `/login?error=${encodeURIComponent(result.error)}`);
    return;
  }

  // Set THIS domain's civ-token cookie (Domain derived from the serving host) and continue.
  setSessionCookie(res, result.token, { host: req.headers.host });
  // One-shot marker so /api/auth/authorize can detect a session cookie that DIDN'T stick (loop recovery).
  const existing = res.getHeader('Set-Cookie');
  const all = Array.isArray(existing)
    ? existing.map(String)
    : existing != null
    ? [String(existing)]
    : [];
  all.push(postLoginMarkerCookie());
  res.setHeader('Set-Cookie', all);
  res.redirect(302, result.returnUrl);
}
