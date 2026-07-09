import { env } from '$env/dynamic/private';
import { isSecureCookie } from '@civitai/auth';

// Single source of truth for the auth cookies' `Domain` attribute (session + device). The Domain MUST be a
// suffix of the hub's own host or the browser silently drops the Set-Cookie — and a hub whose session cookie
// never sticks is an infinite login redirect loop. So:
//   1. `AUTH_COOKIE_DOMAIN` overrides per-env, but ONLY if it's actually a suffix of the hub host; a
//      mismatched override (e.g. `.civitai.com` on a `civitaic.com` staging hub) is IGNORED + warned, falling
//      back to host-only rather than emitting a cookie the browser rejects.
//   2. Otherwise default to the hub's OWN registrable domain (derived from AUTH_JWT_ISSUER) so every sibling
//      subdomain (the app, moderator, test-auth, …) can read the cookie. Self-deriving means staging on a
//      different family domain (civitaic.com) works without special-casing — no hardcoded `.civitai.com`.
// HTTPS-gated: on http/localhost a registrable-domain Domain would be rejected (host doesn't match), so fall
// back to host-only (undefined). `isSecureCookie()` follows the hub's own protocol (AUTH_JWT_ISSUER) — the same
// signal used for the cookies' `Secure` attribute, so the two stay in lockstep.

/** The hub's own hostname (from AUTH_JWT_ISSUER), lower-cased, or undefined if unparseable. */
function hubHost(): string | undefined {
  try {
    return new URL(env.AUTH_JWT_ISSUER ?? '').hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True if `domain` (leading dot tolerated) is the hub host or a parent of it. */
function isSuffixOfHubHost(domain: string): boolean {
  const host = hubHost();
  if (!host) return true; // can't verify (no issuer) → trust the operator rather than blanket-reject
  const d = domain.replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

export const cookieDomain = (): string | undefined => {
  const override = env.AUTH_COOKIE_DOMAIN;
  if (override) {
    if (isSuffixOfHubHost(override)) return override;
    console.warn(
      `[auth/cookie] AUTH_COOKIE_DOMAIN="${override}" is not a suffix of the hub host "${hubHost()}" — ` +
        `ignoring it and setting a host-only cookie (it would otherwise be rejected by the browser).`
    );
    return undefined;
  }

  // Default: the hub's own registrable (2-label) domain, prefixed with a dot so it's shared across siblings.
  if (!isSecureCookie()) return undefined; // http/localhost → host-only
  const host = hubHost();
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const parts = host.split('.');
  return parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : undefined;
};
