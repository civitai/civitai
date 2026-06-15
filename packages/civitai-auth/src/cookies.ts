import { DEVICE_COOKIE_BASE, SECURE_COOKIE_PREFIX, SESSION_COOKIE_BASE } from './constants';

// Single source of truth for the auth cookie names — the hub sets them, the main app sets them, and every
// spoke reads them. The `__Secure-` prefix is a browser-enforced HTTPS-only guarantee, applied when secure
// (prod) and dropped for dev (http localhost).
export const cookiePrefix = (secure: boolean): string => (secure ? SECURE_COOKIE_PREFIX : '');

/**
 * Whether auth cookies are secure (the `Secure` attribute + the `__Secure-` name prefix). The SINGLE shared
 * signal so the hub and every spoke derive identical names: the hub issuer's protocol (`AUTH_JWT_ISSUER`) —
 * https in prod, http in dev. Read straight off `process.env` (no full env validation) so it's safe at module
 * load. The cookie's `Secure` attribute must be set from this same value wherever a cookie is written.
 */
export const isSecureCookie = (): boolean =>
  (process.env.AUTH_JWT_ISSUER ?? '').startsWith('https://');

// `secure` defaults to the env-derived value, so call sites can just use `sessionCookieName()` — pass an
// explicit boolean only to override (tests, or clearing BOTH prefixes on logout).
export const sessionCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${SESSION_COOKIE_BASE}`;

export const deviceCookieName = (secure: boolean = isSecureCookie()): string =>
  `${cookiePrefix(secure)}${DEVICE_COOKIE_BASE}`;
