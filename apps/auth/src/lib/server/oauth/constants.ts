// Ported verbatim from the main app's src/server/oauth/constants.ts — the OAuth provider's TTLs and
// token prefix MUST be identical across both apps (a hub-issued token's lifetime/prefix has to match
// what the main app's bearer validation expects).
export const OAUTH_TOKEN_PREFIX = 'civitai_';
export const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
export const AUTH_CODE_TTL = 10 * 60; // 10 minutes
export const DEVICE_CODE_TTL = 15 * 60; // 15 minutes
export const DEVICE_POLL_INTERVAL = 5; // seconds
