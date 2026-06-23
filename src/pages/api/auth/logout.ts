import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionCookieName, deviceCookieName, createSessionTokenClient } from '@civitai/auth';
import { cookieDomainForHost, clearLegacyNextAuthCookies } from '~/server/auth/civ-cookie';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

// Main-app logout for the hub flow. Clears BOTH the hub's civ-token AND the legacy next-auth session cookie
// (`civitai-token`) — getServerAuthSession's hybrid path falls back to the legacy cookie, so leaving it would
// keep a legacy-cookie user logged in — plus the orchestrator cookie AND the device cookie (`civ-device`) that
// gates seamless multi-account switching (HttpOnly, so the client can't clear it; on a shared machine the
// "switch back without re-login" set would otherwise survive logout). Best-effort revokes the token at the
// hub, then redirects. Reached via handleSignOut when the hub is configured. See docs/main-app-auth-cutover.md (B).
const sessionTokenClient = createSessionTokenClient();

const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];

// The `.{hostname}` parent domain next-auth used for the LEGACY session cookie on non-localhost hosts.
function legacyParentDomain(host: string | undefined): string | undefined {
  const h = (host ?? '').split(':')[0];
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return undefined;
  return `.${h}`;
}

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
  // civ-token + civ-device are set by the spoke (civ-cookie.ts setSessionCookie) with `cookieDomainForHost()`
  // — the REGISTRABLE domain (e.g. civitai.com), or AUTH_COOKIE_DOMAIN — NOT `.{host}`. Clear over that EXACT
  // scope, else a preview/staging SUBDOMAIN (host `stage.civitai.com`, cookie `Domain=civitai.com`) keeps its
  // cookie after logout. Host-only is the defensive fallback; the registrable already folds in
  // AUTH_COOKIE_DOMAIN when it scopes the host, but include the raw override too for the hub-set device cookie.
  const civDomains = [
    undefined,
    process.env.AUTH_COOKIE_DOMAIN || undefined,
    cookieDomainForHost(host),
  ];
  // legacy civitai-token: next-auth scoped it by NEXTAUTH_COOKIE_DOMAIN or the request-derived `.{host}`.
  const legacyDomains = [
    undefined,
    process.env.NEXTAUTH_COOKIE_DOMAIN || undefined,
    legacyParentDomain(host),
  ];

  return [
    // new hub session cookie — clear BOTH prefixes explicitly (defensive: nuke it regardless of how it was set)
    ...clearCookie(sessionCookieName(false), false, civDomains),
    ...clearCookie(sessionCookieName(true), true, civDomains),
    // device cookie (account-switch device set) — HttpOnly, so it can ONLY be cleared server-side here. Leaving
    // it would let the seamless-switch account set survive logout on a shared machine. Clear BOTH prefixes.
    ...clearCookie(deviceCookieName(false), false, civDomains),
    ...clearCookie(deviceCookieName(true), true, civDomains),
    // legacy next-auth session cookie (hybrid fallback reads it)
    ...clearCookie('civitai-token', false, legacyDomains),
    ...clearCookie('__Secure-civitai-token', true, legacyDomains),
    // ancillary next-auth cruft (CSRF / callback-url / OAuth state + PKCE) — none authenticate, but fully
    // de-crud the browser on logout so nothing next-auth lingers post-cutover.
    ...clearLegacyNextAuthCookies(host),
    // orchestrator service-auth cookie (host-only)
    `${generationServiceCookie.name}=; Path=/; Max-Age=0; SameSite=Lax`,
  ];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const callbackUrl = safeCallback(req.query.callbackUrl);
  const token = req.cookies[sessionCookieName()];

  // Best-effort token revocation at the hub. The cookie clears below end the session client-side, so a hub
  // blip must never block logout (the helper never throws).
  if (token) await sessionTokenClient.revoke(token);

  res.setHeader('Set-Cookie', buildLogoutCookies(req.headers.host));

  res.redirect(302, callbackUrl);
}
