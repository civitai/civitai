import { SECURE_COOKIE_PREFIX, SESSION_COOKIE_BASE } from './constants';

// Single source of truth for the session cookie name — the hub sets it, the main app's
// libs/auth.ts sets it, and every spoke verifier reads it. Keep them all on this.
export const cookiePrefix = (secure: boolean): string => (secure ? SECURE_COOKIE_PREFIX : '');

export const sessionCookieName = (secure: boolean): string =>
  `${cookiePrefix(secure)}${SESSION_COOKIE_BASE}`;
