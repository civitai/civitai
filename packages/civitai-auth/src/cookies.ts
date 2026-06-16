import { DEVICE_COOKIE_BASE, SECURE_COOKIE_PREFIX, SESSION_COOKIE_BASE } from './constants';

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
 */
export const isSecureCookie = (): boolean =>
  (process.env.NEXT_PUBLIC_BASE_URL ?? process.env.AUTH_JWT_ISSUER ?? '').startsWith('https://');

// `secure` defaults to the env-derived value, so call sites can just use `sessionCookieName()` — pass an
// explicit boolean only to override (tests, or clearing BOTH prefixes on logout).
export const sessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${SESSION_COOKIE_BASE}`;

export const deviceCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${DEVICE_COOKIE_BASE}`;
