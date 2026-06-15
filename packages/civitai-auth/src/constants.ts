// Shared auth-contract constants — single source of truth so the hub, the main app, and every
// spoke reference identical names. Drift here = silent auth breakage (the cookie-name collision
// that broke local sessions was exactly this class of bug).

// The thin-session cookie. Deliberately DISTINCT from the legacy next-auth cookie (`civitai-token`, still
// set by the main app's libs/auth.ts) so the hub (thin ES256) and a still-live next-auth never share — and
// stomp — the same cookie during cutover. Existing next-auth sessions simply re-login at the hub.
export const SESSION_COOKIE_BASE = 'civ-token';
// Per-browser device id cookie (account-switch device set, section E). Same secure-prefix rules as the
// session cookie — derive its name via `deviceCookieName(secure)`, never hardcode the prefixed literal.
export const DEVICE_COOKIE_BASE = 'civ-device';
export const SECURE_COOKIE_PREFIX = '__Secure-';

// Cross-domain account sync query param (preferred + legacy).
export const SYNC_PARAM = 'sync';
export const LEGACY_SYNC_PARAM = 'sync-account';

// Credentials-provider id the cross-root receiver registers; the client signIn() id must match.
export const ACCOUNT_SWITCH_PROVIDER_ID = 'account-switch';

// Signals to the client that its session cookie should be refreshed (mirrors the main app's
// shared/constants/auth.constants.ts).
export const SESSION_REFRESH_HEADER = 'x-session-refresh';
export const SESSION_REFRESH_COOKIE = 'civ-session-refresh';

// NB: the redis session key names (TOKEN_STATE / USER_TOKENS / ALL) are intentionally NOT
// declared here — they're owned by @civitai/redis (REDIS_SYS_KEYS.SESSION.* /
// REDIS_KEYS.SESSION.USER_TOKENS) and INJECTED into createSessionRegistry by the app, so there's
// no second copy to drift and @civitai/auth takes no dependency on @civitai/redis.
