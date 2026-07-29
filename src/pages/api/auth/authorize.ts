import type { NextApiRequest, NextApiResponse } from 'next';
import {
  resolveSelfOrigin,
  buildAuthorizeRedirect,
  safePath,
  clearBridgeCookie,
  buildBridgeProbeCookie,
  HUB_BASE_URL,
} from '~/server/auth/oauth-bridge';
import { sessionCookieName } from '@civitai/auth';
import {
  clearAllSessionCookies,
  cookieDomainForHost,
  POST_LOGIN_MARKER,
  LOGIN_RETRY_COOKIE,
  loginRetryCookie,
  clearLoginRetryCookie,
  clearPostLoginMarker,
} from '~/server/auth/civ-cookie';
import { renderSignInProblemHtml } from '~/server/auth/login-error-page';
import { logToAxiom } from '~/server/logging/client';

// Fire-and-forget structured log for the cross-domain login legs. The auth hub doesn't ship to Axiom, but these
// spoke endpoints run in the main app (which does), so this is where the .red-vs-.com return-leg outcomes become
// queryable — `['civitai-prod'] | where name == 'auth-flow'` (ClickUp 868k9gug8). host distinguishes the color.
const logAuth = (req: NextApiRequest, outcome: string, extra?: Record<string, unknown>) =>
  logToAxiom(
    { name: 'auth-flow', step: 'authorize', outcome, host: req.headers.host, ...extra },
    'civitai-prod'
  ).catch(() => undefined);

// GET /api/auth/authorize — INITIATE first-party cross-domain login. A spoke on a different registrable domain
// (civitai.red / a test host / localhost) can't read the hub's `.civitai.com` cookie, so it runs the OAuth
// authorization-code + PKCE flow against the hub. This is a THIN Next wrapper: derive this spoke's origin, then
// the package bridge builds the hub /authorize URL (first-party client_id + exact redirect_uri + state + S256
// challenge) and the bridge cookie (PKCE verifier + state + returnUrl, for /api/auth/callback). The bridge core
// lives in @civitai/auth (first-party-bridge) — shared with every spoke + unit-tested there.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!HUB_BASE_URL) {
    logAuth(req, 'hub-not-configured');
    res.status(500).json({ error: 'hub not configured' });
    return;
  }
  const selfOrigin = resolveSelfOrigin(req);
  if (!selfOrigin) {
    logAuth(req, 'no-self-origin');
    res.status(500).json({ error: 'self origin not resolvable' });
    return;
  }

  // Scope the bridge cookie to the REGISTRABLE domain (civitai.red) so it survives a host variation (www↔apex)
  // between this /authorize (where it's set) and /callback (where it's read) — host-only was being dropped there
  // while the Domain-scoped session cookies survived. Derive it from `req.headers.host` — the SAME source the
  // session cookies and the /callback clear use — so set and clear always agree. Undefined on localhost/IP →
  // host-only (dev). `secure` follows the request protocol (x-forwarded-proto, via selfOrigin); this matches the
  // package's env-derived isSecureCookie() in every real env (prod all-https / dev all-http).
  const authHost = req.headers.host ?? '';
  const secure = selfOrigin.startsWith('https://');
  const cookieDomain = cookieDomainForHost(req.headers.host);

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
      logAuth(req, 'loop-terminal', { retries });
      res.setHeader('Set-Cookie', [
        ...clearAllSessionCookies(req.headers.host),
        clearBridgeCookie(undefined, cookieDomain), // match the Domain the bridge cookie was set with
      ]);
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderSignInProblemHtml());
      return;
    }
    // First miss → consume the stale marker, bump the retry counter, and fall through to a fresh login attempt.
    logAuth(req, 'cookie-miss-retry', { retries });
    cookieOps.push(clearPostLoginMarker(), loginRetryCookie(retries + 1));
  } else if (req.cookies[LOGIN_RETRY_COOKIE]) {
    // A clean entry (no pending miss) starts a fresh login chain — reset any leftover retry budget.
    cookieOps.push(clearLoginRetryCookie());
  }

  const { location, setCookie } = buildAuthorizeRedirect({
    selfOrigin,
    returnUrl: safePath(req.query.returnUrl),
    cookieDomain,
  });
  const bridge = Array.isArray(setCookie) ? setCookie : [setCookie];
  // Diagnostic probe alongside the bridge cookie (Domain-scoped, 1h) so /callback can classify a missing bridge
  // cookie (host variation vs expiry vs full block). Remove once the .red no_cookie cause is settled.
  const probe = buildBridgeProbeCookie({ host: authHost, domain: cookieDomain, secure });
  res.setHeader('Set-Cookie', [...bridge, probe, ...cookieOps]);
  res.redirect(302, location);
}
