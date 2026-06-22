import type { NextApiRequest, NextApiResponse } from 'next';
import { setSessionCookie } from '~/server/auth/civ-cookie';
import {
  HUB_BASE_URL,
  OAUTH_BRIDGE_COOKIE,
  resolveSelfOrigin,
  firstPartyClientId,
  safePath,
  clearBridgeCookie,
} from '~/server/auth/oauth-bridge';

// GET /api/auth/callback — RECEIVE the hub's authorization-code redirect (replaces sync.ts's `?swap=`
// receive role). Verify `state` against the bridge cookie, exchange the code for a civ-token SESSION at
// the hub's first-party /session endpoint (server-to-server with the PKCE verifier), set THIS domain's
// civ-token cookie via the existing setSessionCookie(), and continue to returnUrl. Cookie format is
// unchanged → existing sessions unaffected.
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

  // Read + single-use clear the bridge cookie (verifier + state + returnUrl).
  let stash: { v?: string; s?: string; r?: string } | undefined;
  const raw = req.cookies[OAUTH_BRIDGE_COOKIE];
  if (raw) {
    try {
      stash = JSON.parse(raw);
    } catch {
      // ignore a malformed cookie — treated as a missing stash below
    }
  }
  res.setHeader('Set-Cookie', clearBridgeCookie());

  const returnUrl = safePath(stash?.r);

  // Deny / error from the hub → back to login with the reason.
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;
  if (error) {
    res.redirect(302, `/login?error=${encodeURIComponent(error)}`);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  // CSRF: the returned state must match the one we stashed (and we must have a verifier).
  if (!code || !state || !stash?.v || !stash.s || state !== stash.s) {
    res.redirect(302, '/login?error=oauth_state');
    return;
  }

  // Exchange the code for a civ-token SESSION at the hub (server-to-server, with the PKCE verifier).
  const clientId = firstPartyClientId(selfOrigin);
  let token: string | undefined;
  try {
    const resp = await fetch(`${HUB_BASE_URL}/api/auth/oauth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: stash.v, client_id: clientId }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { token?: string };
      token = data.token;
    }
  } catch {
    // network/hub error — fall through to the error redirect
  }

  if (!token) {
    res.redirect(302, '/login?error=oauth_exchange');
    return;
  }

  // Set THIS domain's civ-token cookie (Domain derived from the serving host) and continue.
  setSessionCookie(res, token, { host: req.headers.host });
  res.redirect(302, returnUrl);
}
