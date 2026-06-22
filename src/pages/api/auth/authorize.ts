import type { NextApiRequest, NextApiResponse } from 'next';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  HUB_BASE_URL,
  SPOKE_CALLBACK_PATH,
  resolveSelfOrigin,
  firstPartyClientId,
  safePath,
  generatePkce,
  randomState,
  bridgeCookie,
} from '~/server/auth/oauth-bridge';

// GET /api/auth/authorize — INITIATE first-party cross-domain login (replaces sync.ts's initiate role).
// A spoke on a different registrable domain (civitai.red / a test host / localhost) can't read the hub's
// `.civitai.com` cookie, so we run the standard OAuth authorization-code + PKCE flow against the hub:
// build the hub /authorize URL (this spoke's first-party client_id + exact redirect_uri + state + S256
// challenge) and 302 there via a top-level navigation. The PKCE verifier + state + returnUrl are stashed
// in a short-lived httpOnly cookie for /api/auth/callback to verify + redeem. No swap token, no bespoke
// crypto — `state`/PKCE/exact-redirect_uri come for free.
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

  const returnUrl = safePath(req.query.returnUrl);
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const clientId = firstPartyClientId(selfOrigin);
  const redirectUri = `${selfOrigin.replace(/\/+$/, '')}${SPOKE_CALLBACK_PATH}`;

  // Stash verifier + state + returnUrl for the callback (httpOnly; the cookie never leaves this spoke).
  res.setHeader('Set-Cookie', bridgeCookie(JSON.stringify({ v: verifier, s: state, r: returnUrl })));

  const authorize = new URL(`${HUB_BASE_URL}/api/auth/oauth/authorize`);
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  // First-party requests full session identity (the hub's /session ignores scope, but /authorize validates
  // it and the first-party client's ceiling is Full).
  authorize.searchParams.set('scope', String(TokenScope.Full));
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  res.redirect(302, authorize.toString());
}
