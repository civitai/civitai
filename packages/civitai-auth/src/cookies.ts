import {
  DEVICE_COOKIE_BASE,
  LEGACY_SESSION_COOKIE_BASE,
  SECURE_COOKIE_PREFIX,
  SESSION_COOKIE_BASE,
} from './constants';

// Single source of truth for the auth cookie names — the hub sets them, the main app sets them, and every
// spoke reads them. The `__Secure-` prefix is a browser-enforced HTTPS-only guarantee, applied when secure
// (prod) and dropped for dev (http localhost).
export const cookiePrefix = (secure: boolean): string => (secure ? SECURE_COOKIE_PREFIX : '');

/**
 * Whether auth cookies are secure (the `Secure` attribute + the `__Secure-` name prefix). This follows the
 * APP's OWN serving protocol — `NEXT_PUBLIC_BASE_URL` for a Next spoke (each spoke sets/reads its own cookie),
 * falling back to the hub issuer (`AUTH_JWT_ISSUER`, which the hub sets to its own origin). The distinction
 * matters cross-domain: a localhost (http) spoke talking to the prod (https) hub must use a NON-secure cookie
 * even though the issuer is https. Read straight off `process.env` so it's safe at module load.
 *
 * NB: TRUTHINESS (`||`), not `??` — an EMPTY-string `NEXT_PUBLIC_BASE_URL` must fall through to
 * `AUTH_JWT_ISSUER`. `??` only falls through on null/undefined, so a `NEXT_PUBLIC_BASE_URL=""` (present but
 * empty, common in shared env files) would resolve to `''` → `false` on an HTTPS deploy → the cookie silently
 * loses its `__Secure-` prefix and two apps compute DIFFERENT cookie names → they can't read each other's
 * session (the test-site redirect-loop class of bug). Warn loudly if NEITHER is set.
 */
let warnedNoCookieBase = false;
export const isSecureCookie = (): boolean => {
  const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.AUTH_JWT_ISSUER || '';
  if (!base && !warnedNoCookieBase) {
    warnedNoCookieBase = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[@civitai/auth] neither NEXT_PUBLIC_BASE_URL nor AUTH_JWT_ISSUER is set — auth cookies default to ' +
        'NON-secure naming, which mismatches a secure (https) deploy and breaks cross-app session sharing. ' +
        "Set one to this app's own origin."
    );
  }
  return base.startsWith('https://');
};

// `secure` defaults to the env-derived value, so call sites can just use `sessionCookieName()` — pass an
// explicit boolean only to override (tests, or clearing BOTH prefixes on logout).
export const sessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${SESSION_COOKIE_BASE}`;

export const deviceCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${DEVICE_COOKIE_BASE}`;

// Legacy NextAuth session cookie name — resolved with the SAME dev/prod secure logic as the hub cookie above,
// so prod reads `__Secure-civitai-token` and dev reads `civitai-token`. READ-ONLY during the cutover.
export const legacySessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${LEGACY_SESSION_COOKIE_BASE}`;
