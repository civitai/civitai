import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
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
    // The end-user address, forwarded to the hub on the server-to-server exchange
    // (the bridge sends it as a single-value `x-forwarded-for`; see
    // `packages/civitai-auth/src/first-party-bridge.ts`). Null is coerced to undefined
    // so the bridge omits the header entirely when nothing resolves.
    //
    // DERIVATION: the shared attribution predicate, the same one `createContext` and
    // the ClickHouse tracker bind. This site is on it for the same reason they are —
    // one predicate per surface — and what leaves here is therefore a validated bare
    // address, the same shape this repo records everywhere else.
    //
    // WHERE IT LANDS. Both halves of this seam are in THIS monorepo, so which
    // derivation each side applies is checkable rather than assumed:
    //   PUBLIC path   — the hub runs its own edge-first derivation, which resolves to
    //                   this spoke's egress and takes precedence; the forwarded value
    //                   is shadowed and does not decide anything.
    //   INTERNAL path — the hub has no edge value to prefer, so it falls through to
    //                   the address forwarded here and keys its per-IP session bucket
    //                   on it (`apps/auth/src/lib/server/oauth/rate-limit.ts`).
    //
    // So on the internal path this is a per-end-user bucket key on the far side, and
    // the seam is pinned from BOTH ends: the spoke half — that what is forwarded is
    // this predicate's answer — by
    // `src/__tests__/pages/api/auth/callback.client-ip.test.ts`; the hub half — that
    // the hub derives that same value back out of the forwarded header — by
    // `apps/auth/src/lib/server/auth/__tests__/request.client-ip.test.ts`, in the
    // `app:auth` Vitest project. Neither half alone covers the seam.
    clientIp: resolveClientIpOrNull(req) ?? undefined,
  });

  if ('error' in result) {
    // `detail` sub-classifies oauth_state (no_code / no_cookie / state_mismatch) + oauth_exchange (declined /
    // network). `cookieCount` separates a real failure (>0 = other cookies reached the callback) from a full
    // cross-site block / bot (0 = no cookies at all) — the .red no_cookie residual was ~2/3 already-logged-in
    // duplicate callbacks + ~1/3 bots, with a negligible genuine-failure slice (ClickUp 868k9gug8).
    logAuth(req, 'exchange-error', {
      error: result.error,
      detail: result.detail,
      cookieCount: Object.keys(req.cookies ?? {}).length,
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
