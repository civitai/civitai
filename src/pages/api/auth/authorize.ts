import type { NextApiRequest, NextApiResponse } from 'next';
import {
  resolveSelfOrigin,
  buildAuthorizeRedirect,
  safePath,
  clearBridgeCookie,
  HUB_BASE_URL,
} from '~/server/auth/oauth-bridge';
import { sessionCookieName } from '@civitai/auth';
import {
  clearAllSessionCookies,
  POST_LOGIN_MARKER,
  LOGIN_RETRY_COOKIE,
  loginRetryCookie,
  clearLoginRetryCookie,
  clearPostLoginMarker,
} from '~/server/auth/civ-cookie';

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

  // Loop recovery (retry-tolerant). /api/auth/callback sets a one-shot marker right after minting a session. If
  // the marker is present but the session COOKIE is ABSENT here, the civ-token the callback set didn't arrive —
  // EITHER an intermittent cookie-landing miss (the edge dropped a Set-Cookie) OR a real Domain/Secure misconfig
  // (an infinite redirect loop). We RETRY the login once so a transient miss self-heals, and only show the
  // terminal error on a SECOND consecutive miss (a genuine loop). We test cookie PRESENCE only (no verify, no
  // hub fetch): a cookie that DID stick is sent back regardless, so a good session is never false-triggered and
  // the add-account flow (re-enters /authorize while logged in, cookie present) is unaffected.
  const cookieOps: string[] = [];
  if (req.cookies[POST_LOGIN_MARKER] && !req.cookies[sessionCookieName()]) {
    const retries = Number.parseInt(req.cookies[LOGIN_RETRY_COOKIE] ?? '', 10) || 0;
    if (retries >= 1) {
      // Second consecutive miss → genuine loop. Wipe the wedged cookies (incl. marker + retry budget) and stop.
      res.setHeader('Set-Cookie', [
        ...clearAllSessionCookies(req.headers.host),
        clearBridgeCookie(),
      ]);
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in problem</title>` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<style>body{background:#0b0c10;color:#e8eaed;font-family:system-ui,sans-serif;display:grid;` +
          `place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:1.5rem;text-align:center}` +
          `h1{font-size:1.2rem;margin:0 0 .5rem}p{color:#9aa0a6;font-size:.9rem;line-height:1.5}a{color:#4285f4}` +
          `</style></head><body><div class="card"><h1>We couldn't sign you in</h1><p>Your session couldn't be ` +
          `established — this is usually a temporary cookie issue. We've cleared it; please ` +
          `<a href="/">return home</a> and try signing in again.</p></div></body></html>`
      );
      return;
    }
    // First miss → consume the stale marker, bump the retry counter, and fall through to a fresh login attempt.
    cookieOps.push(clearPostLoginMarker(), loginRetryCookie(retries + 1));
  } else if (req.cookies[LOGIN_RETRY_COOKIE]) {
    // A clean entry (no pending miss) starts a fresh login chain — reset any leftover retry budget.
    cookieOps.push(clearLoginRetryCookie());
  }

  const { location, setCookie } = buildAuthorizeRedirect({
    selfOrigin,
    returnUrl: safePath(req.query.returnUrl),
  });
  const bridge = Array.isArray(setCookie) ? setCookie : [setCookie];
  res.setHeader('Set-Cookie', [...bridge, ...cookieOps]);
  res.redirect(302, location);
}
