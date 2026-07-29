import type { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import { sessionCookieName } from '@civitai/auth';
import {
  setSessionCookie,
  postLoginMarkerCookie,
  clearLegacyCookies,
  hasAnyLegacyCookie,
  cookieDomainForHost,
} from '~/server/auth/civ-cookie';
import {
  resolveSelfOrigin,
  completeFirstPartyCallback,
  clearBridgeCookie,
  OAUTH_BRIDGE_COOKIE,
  BRIDGE_PROBE_COOKIE,
  readBridgeProbe,
  HUB_BASE_URL,
} from '~/server/auth/oauth-bridge';
import { logToAxiom } from '~/server/logging/client';

// Fire-and-forget structured log — see the note in authorize.ts. `['civitai-prod'] | where name == 'auth-flow'`;
// host distinguishes .red vs .com, so an exchange failing on one color but not the other is visible here.
const logAuth = (req: NextApiRequest, outcome: string, extra?: Record<string, unknown>) =>
  logToAxiom(
    { name: 'auth-flow', step: 'callback', outcome, host: req.headers.host, ...extra },
    'civitai-prod'
  ).catch(() => undefined);

// GET /api/auth/callback — RECEIVE the hub's authorization-code redirect. A THIN Next wrapper over the package
// bridge: verify `state` against the bridge cookie + exchange the code for a civ-token SESSION at the hub's
// first-party /session endpoint (server-to-server with the PKCE verifier), then set THIS domain's civ-token
// cookie via setSessionCookie() and continue to returnUrl. The CSRF/exchange logic lives in @civitai/auth
// (first-party-bridge). Cookie format is unchanged → existing sessions unaffected.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Don't leak the code/state in the inbound URL onward via Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');

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

  // Single-use clear of the bridge cookie regardless of outcome (setSessionCookie appends to this on success).
  // Pass the registrable Domain so a Domain-scoped bridge cookie is actually cleared (host-only clear wouldn't).
  const cookieDomain = cookieDomainForHost(req.headers.host);
  res.setHeader('Set-Cookie', clearBridgeCookie(undefined, cookieDomain));

  const result = await completeFirstPartyCallback({
    selfOrigin,
    query: {
      code: typeof req.query.code === 'string' ? req.query.code : null,
      state: typeof req.query.state === 'string' ? req.query.state : null,
      error: typeof req.query.error === 'string' ? req.query.error : null,
    },
    bridgeCookieValue: req.cookies[OAUTH_BRIDGE_COOKIE],
    // The real end-user IP (request-ip resolver, same as createContext/tracker) — it reads x-forwarded-for
    // FIRST (leftmost hop) then cf-connecting-ip. Forwarded to the hub as a single-value x-forwarded-for on the
    // server-to-server exchange. On the INTERNAL path (no CF/proxy in front of the hub) this forwarded value is
    // authoritative — it's what the hub's flood-guard keys on; on the PUBLIC path the hub's own cf-first
    // getClientIp takes precedence (cf-connecting-ip = the spoke egress) and this is harmlessly shadowed. Coerce
    // the resolver's null to undefined so the bridge omits the header when nothing resolves.
    clientIp: requestIp.getClientIp(req) ?? undefined,
  });

  if ('error' in result) {
    // `detail` sub-classifies oauth_state (no_code / no_cookie / state_mismatch) + oauth_exchange (declined /
    // network). For `no_cookie` we attach diagnostics to pin the cause: `userAgent` (Safari/ITP full-block vs
    // bot vs modern browser), `cookieCount` (0 = every host cookie lost; >0 = only the bridge cookie dropped),
    // and the Domain-scoped 1h PROBE — which the host-only bridge cookie's own before/after can't distinguish:
    //   probe present, probeAuthHost ≠ this host → a host variation (www↔apex) the new Domain scope now covers;
    //   probe present, probeAgeMs > 10min        → the login outran the bridge cookie's TTL (expiry);
    //   probe absent                             → full cross-site block / bot (no cookies survived at all).
    const probe = readBridgeProbe(req.cookies[BRIDGE_PROBE_COOKIE]);
    logAuth(req, 'exchange-error', {
      error: result.error,
      detail: result.detail,
      userAgent: req.headers['user-agent'],
      cookieCount: Object.keys(req.cookies ?? {}).length,
      probePresent: !!probe,
      probeAuthHost: probe?.authHost,
      probeAgeMs: probe?.ageMs,
      // Already-authenticated on a `no_cookie` callback ⇒ a prior callback in this flow already succeeded and
      // cleared the (single-use) bridge cookie, so THIS is a duplicate/retried hit, not a real lockout.
      hasSession: !!req.cookies[sessionCookieName()],
    });
    res.redirect(302, `/login?error=${encodeURIComponent(result.error)}`);
    return;
  }
  logAuth(req, 'success');

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
