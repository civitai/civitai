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
// Legacy NextAuth session cookie — READ-ONLY during the cutover (decoded by the jose helper). Same secure-prefix
// rules as the others, so resolve its name via `legacySessionCookieName(secure)`, never hardcode the literal
// (prod is `__Secure-civitai-token`, not `civitai-token`).
export const LEGACY_SESSION_COOKIE_BASE = 'civitai-token';
export const SECURE_COOKIE_PREFIX = '__Secure-';

// Cross-domain account sync query param — the single marker the hub re-attaches after login and the
// destination's useDomainSync reads to kick off the auth-code flow (/api/auth/authorize).
export const SYNC_PARAM = 'sync-account';

// The registrable domains (eTLD+1) the Civitai family owns. The single source of truth for "is this one of
// our hosts" — the post-login redirect guard (isCivitaiOrigin) and any other family-host check reference THIS
// list so they can't drift. `civitaic.com` is the auto-deploy PREVIEW domain (ephemeral per-PR hosts like
// pr-2468.civitaic.com) — it MUST be here or the unified login funnel drops the spoke's returnUrl on previews.
// NB: this is the registrable-domain OWNERSHIP list (a static, DB-free security guard); the OAuth
// `TrustedSpokeDomain` table is the SEPARATE per-host AUTHORIZATION registry (async, DB-backed, finer-grained).
// Both must know about every family domain, but they answer different questions — see isCivitaiOrigin.
export const CIVITAI_OWNED_DOMAINS = ['civitai.com', 'civitai.red', 'civitaic.com'] as const;

// Credentials-provider id the cross-root receiver registers; the client signIn() id must match.
export const ACCOUNT_SWITCH_PROVIDER_ID = 'account-switch';

// Signals to the client that its session cookie should be refreshed (mirrors the main app's
// shared/constants/auth.constants.ts).
export const SESSION_REFRESH_HEADER = 'x-session-refresh';
export const SESSION_REFRESH_COOKIE = 'civ-session-refresh';

// NB: redis session key names (TOKEN_STATE / USER_TOKENS / ALL) are NOT declared here — they're owned by
// @civitai/redis and injected into createSessionRegistry, so @civitai/auth takes no redis dependency.
