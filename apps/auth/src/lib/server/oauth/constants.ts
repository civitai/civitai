// Ported verbatim from the main app's src/server/oauth/constants.ts — the OAuth provider's TTLs and
// token prefix MUST be identical across both apps (a hub-issued token's lifetime/prefix has to match
// what the main app's bearer validation expects).
export const OAUTH_TOKEN_PREFIX = 'civitai_';
export const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
export const AUTH_CODE_TTL = 10 * 60; // 10 minutes
export const DEVICE_CODE_TTL = 15 * 60; // 15 minutes
export const DEVICE_POLL_INTERVAL = 5; // seconds
export const APP_TOKEN_DEFAULT_TTL = 15 * 60; // 15 minutes
export const APP_TOKEN_MAX_TTL = ACCESS_TOKEN_TTL;

// Worker identity: a workload client's worker trades a device credential for a short-lived `Worker` token
// through the token-exchange grant (RFC 8693). No refresh token; the worker exchanges again before expiry.
export const WORKER_TOKEN_TTL = 15 * 60; // 15 minutes
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const DEVICE_ID_TOKEN_TYPE = 'urn:civitai:token-type:device-id';
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
/** A worker device id, as sent in `subject_token` or read from a Salad token's machine id. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** The civitai system account (User id -1): owner of system OAuth apps, the first-party convention. */
export const SYSTEM_USER_ID = -1;
/** Held by the account that owns workload clients. The hub produces no session for a holder. */
export const SYSTEM_WORKLOAD_ROLE = 'system:workload';
