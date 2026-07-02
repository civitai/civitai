import type { NextApiRequest, NextApiResponse } from 'next';
import {
  setSessionCookie,
  postLoginMarkerCookie,
  clearLegacyCookies,
  hasAnyLegacyCookie,
} from '~/server/auth/civ-cookie';
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

/**
 * The real END-USER IP for the request, forwarded to the hub on the server-to-server session exchange (same
 * convention as dev-token.ts / the OAuth proxy). First XFF entry (client-most), then cf-connecting-ip, then the
 * socket peer. Returns undefined when nothing resolves so the bridge simply omits the header.
 */
function endUserIp(req: NextApiRequest): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  const cf = req.headers['cf-connecting-ip'];
  const cfFirst = Array.isArray(cf) ? cf[0] : cf;
  const ip = first ?? cfFirst ?? req.socket?.remoteAddress;
  return ip?.trim() || undefined;
}

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
    clientIp: endUserIp(req),
  });

  if ('error' in result) {
    res.redirect(302, `/login?error=${encodeURIComponent(result.error)}`);
    return;
  }

  // Set THIS domain's civ-token cookie (Domain derived from the serving host) and continue.
  // Set THIS domain's civ-token + civ-device (the shared family device id from the hub) so its session AND
  // account switcher match the rest of the family. deviceCookie no-ops if the hub returned no id.
  setSessionCookie(res, result.token, { host: req.headers.host, deviceCookie: result.deviceId });
  // One-shot marker so /api/auth/authorize can detect a session cookie that DIDN'T stick (loop recovery).
  const existing = res.getHeader('Set-Cookie');
  const all = Array.isArray(existing)
    ? existing.map(String)
    : existing != null
    ? [String(existing)]
    : [];
  all.push(postLoginMarkerCookie());
  // De-crud the browser at the legacy->civ-token transition: expire every leftover next-auth cookie — the
  // SESSION cookie (so the hybrid fallback can't keep a migrated user on the stale legacy identity) AND the
  // ancillary cruft (CSRF / callback-url / OAuth state + PKCE). ONLY when the browser actually still carries a
  // legacy cookie — otherwise this would add ~24 useless Set-Cookie headers to every login, bloating this hot
  // response near the edge header limit and risking the real civ-token Set-Cookie getting dropped.
  if (hasAnyLegacyCookie(req.cookies)) all.push(...clearLegacyCookies(req.headers.host));
  res.setHeader('Set-Cookie', all);
  res.redirect(302, result.returnUrl);
}
