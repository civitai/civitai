import type { NextApiRequest, NextApiResponse } from 'next';
import {
  sessionCookieName,
  deviceCookieName,
  createSessionTokenClient,
  hubLogoutUrl,
} from '@civitai/auth';
import {
  cookieDomainForHost,
  clearLegacyCookies,
  POST_LOGIN_MARKER,
} from '~/server/auth/civ-cookie';
import { resolveSelfOrigin } from '~/server/auth/oauth-bridge';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

// Main-app logout for the hub flow. Clears BOTH the hub's civ-token AND the legacy next-auth session cookie
// (`civitai-token`) — getServerAuthSession's hybrid path falls back to the legacy cookie, so leaving it would
// keep a legacy-cookie user logged in — plus the orchestrator cookie AND the device cookie (`civ-device`) that
// gates seamless multi-account switching (HttpOnly, so the client can't clear it; on a shared machine the
// "switch back without re-login" set would otherwise survive logout). Best-effort revokes the token at the
// hub, then redirects. Reached via handleSignOut when the hub is configured. See docs/main-app-auth-cutover.md (B).
const sessionTokenClient = createSessionTokenClient();
const HUB = (process.env.AUTH_JWT_ISSUER ?? '').replace(/\/+$/, '');

// The hub's registrable domain (e.g. civitai.com). A spoke whose own registrable domain DIFFERS is CROSS-SITE:
// its logout response can't clear the hub's `.civitai.com` cookies, and the hub session is a SEPARATE token, so
// a local-only logout leaves the hub session alive and the user is re-SSO'd straight back in. Such spokes must
// finish logout THROUGH the hub (see handler). Same-registrable-domain spokes share the hub cookie → local
// clear + token revoke is already complete.
function hubRegistrableDomain(): string | undefined {
  try {
    return HUB ? cookieDomainForHost(new URL(HUB).host) : undefined;
  } catch {
    return undefined;
  }
}

const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];

// Clear a cookie across host-only + each candidate domain, so we match however it was actually set.
// Clearing a non-existent variant is harmless.
function clearCookie(name: string, secure: boolean, domains: (string | undefined)[]): string[] {
  return uniq(domains).map((d) => {
    const base = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
    return d ? `${base}; Domain=${d}` : base;
  });
}

function safeCallback(cb: unknown): string {
  if (typeof cb !== 'string' || !cb) return '/';
  return cb.startsWith('/') && !cb.startsWith('//') && !cb.startsWith('/\\') ? cb : '/';
}

// The full set of Set-Cookie headers that end a session on this host. Pulled out so the cookie names cleared
// (in particular the device cookie that gates seamless switching) are unit-testable without an HTTP round-trip.
export function buildLogoutCookies(host: string | undefined): string[] {
  // civ-token + civ-device are set by the spoke (civ-cookie.ts setSessionCookie) with `cookieDomainForHost()` —
  // the REGISTRABLE domain (e.g. civitai.com), NOT `.{host}`. Clear over that EXACT scope (plus host-only as a
  // defensive fallback), else a preview/staging SUBDOMAIN (host `stage.civitai.com`, cookie `Domain=civitai.com`)
  // keeps its cookie after logout. The registrable scope ALSO clears the HUB-set `.civitai.com` device cookie: a
  // Max-Age=0 over the derived `civitai.com` deletes a `.civitai.com` cookie (RFC 6265 — leading dot is the same
  // scope), so the main app needs no knowledge of (and never reads) the hub-only AUTH_COOKIE_DOMAIN.
  const civDomains = [undefined, cookieDomainForHost(host)];

  return [
    // new hub session cookie — clear BOTH prefixes explicitly (defensive: nuke it regardless of how it was set)
    ...clearCookie(sessionCookieName(false), false, civDomains),
    ...clearCookie(sessionCookieName(true), true, civDomains),
    // device cookie (account-switch device set) — HttpOnly, so it can ONLY be cleared server-side here. Leaving
    // it would let the seamless-switch account set survive logout on a shared machine. Clear BOTH prefixes.
    ...clearCookie(deviceCookieName(false), false, civDomains),
    ...clearCookie(deviceCookieName(true), true, civDomains),
    // every legacy next-auth cookie — the SESSION cookie (the hybrid fallback reads it) AND the ancillary cruft
    // (CSRF / callback-url / OAuth state + PKCE). Single source (clearLegacyCookies) — clears over the
    // registrable domain, so a subdomain logout host doesn't orphan the `.civitai.com` legacy session cookie.
    ...clearLegacyCookies(host),
    // orchestrator service-auth cookie (host-only)
    `${generationServiceCookie.name}=; Path=/; Max-Age=0; SameSite=Lax`,
    // post-login loop-recovery marker (host-only). MUST be cleared on logout: it's a one-shot "did the session
    // cookie land?" probe with a 60s TTL, set by /api/auth/callback. If logout wipes civ-token but leaves this,
    // a logout-then-login WITHIN that 60s window looks identical to "the cookie didn't stick" — so
    // /api/auth/authorize false-fires its loop-recovery and shows "We couldn't sign you in".
    `${POST_LOGIN_MARKER}=; Path=/; Max-Age=0; SameSite=Lax`,
  ];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const callbackUrl = safeCallback(req.query.callbackUrl);
  const token = req.cookies[sessionCookieName()];

  // Always clear THIS spoke's own cookies (registrable domain) + best-effort revoke its token's jti at the hub
  // (stops replay of the just-cleared token; a hub blip must never block logout, so revoke never throws).
  res.setHeader('Set-Cookie', buildLogoutCookies(req.headers.host));
  if (token) await sessionTokenClient.revoke(token);

  // Cross-site spoke (e.g. civitai.red): finish logout THROUGH the hub so the browser actually receives the
  // `.civitai.com` cookie-clears AND the hub session token gets revoked — otherwise the surviving hub session
  // re-SSOs the user right back in. Bounce to the hub logout landing with an absolute returnUrl back here; the
  // hub validates that returnUrl against the trusted-spoke registry before redirecting back.
  const spokeDomain = cookieDomainForHost(req.headers.host);
  const hubDomain = hubRegistrableDomain();
  const crossSite = !!HUB && !!spokeDomain && !!hubDomain && spokeDomain !== hubDomain;
  if (crossSite) {
    const selfOrigin = resolveSelfOrigin(req);
    const returnUrl = selfOrigin ? `${selfOrigin.replace(/\/+$/, '')}${callbackUrl}` : callbackUrl;
    res.redirect(302, hubLogoutUrl(HUB, returnUrl));
    return;
  }

  // Same-site spoke: it shares the hub's `.civitai.com` cookie, so the clears above already ended the hub
  // session everywhere on that domain — just continue locally.
  res.redirect(302, callbackUrl);
}
