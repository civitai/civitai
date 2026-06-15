import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionCookieName } from '@civitai/auth';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

// Main-app logout for the hub flow. Clears BOTH the hub's civ-token AND the legacy next-auth session cookie
// (`civitai-token`) — getServerAuthSession's hybrid path falls back to the legacy cookie, so leaving it would
// keep a legacy-cookie user logged in — plus the orchestrator cookie. Best-effort revokes the token at the
// hub, then redirects. Reached via handleSignOut when the hub is configured. See docs/main-app-auth-cutover.md (B).
const HUB = process.env.AUTH_JWT_ISSUER; // hub origin (token issuer)

const uniq = <T>(arr: T[]): T[] => [...new Set(arr)];

// The `.{hostname}` parent domain next-auth uses for the session cookie on non-localhost hosts.
function parentDomain(req: NextApiRequest): string | undefined {
  const host = (req.headers.host ?? '').split(':')[0];
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  return `.${host}`;
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const callbackUrl = safeCallback(req.query.callbackUrl);
  const token = req.cookies[sessionCookieName()];

  // Best-effort token revocation at the hub. The cookie clears below end the session client-side, so a hub
  // blip must never block logout. Forward under the ACTUAL (env-derived) cookie name so the hub reads it.
  if (HUB && token) {
    await fetch(`${HUB.replace(/\/+$/, '')}/logout`, {
      method: 'POST',
      headers: { cookie: `${sessionCookieName()}=${token}` },
      redirect: 'manual',
    }).catch(() => null);
  }

  const dParent = parentDomain(req);
  // civ-token: scoped by AUTH_COOKIE_DOMAIN (hub) or host-only.
  const civDomains = [undefined, process.env.AUTH_COOKIE_DOMAIN || undefined, dParent];
  // legacy civitai-token: scoped by NEXTAUTH_COOKIE_DOMAIN or the request-derived `.{host}`.
  const legacyDomains = [undefined, process.env.NEXTAUTH_COOKIE_DOMAIN || undefined, dParent];

  res.setHeader('Set-Cookie', [
    // new hub session cookie — clear BOTH prefixes explicitly (defensive: nuke it regardless of how it was set)
    ...clearCookie(sessionCookieName(false), false, civDomains),
    ...clearCookie(sessionCookieName(true), true, civDomains),
    // legacy next-auth session cookie (hybrid fallback reads it)
    ...clearCookie('civitai-token', false, legacyDomains),
    ...clearCookie('__Secure-civitai-token', true, legacyDomains),
    // orchestrator service-auth cookie (host-only)
    `${generationServiceCookie.name}=; Path=/; Max-Age=0; SameSite=Lax`,
  ]);

  res.redirect(302, callbackUrl);
}
