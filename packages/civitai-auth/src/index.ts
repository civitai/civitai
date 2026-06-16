// @civitai/auth — verify/receive SDK (Path C: asymmetric JWT + JWKS).
// See docs/auth-verification-strategy.md and docs/centralized-auth-app.md.
//
//  SPOKE (every app):   createAuthVerifier — local verify, no per-request hop.
//                       createAccountSwitchProvider — cross-root session receiver.
//                       createAuthMiddleware — edge route guard.
//  HUB   (apps/auth):    createSessionSigner / maybeCreateSessionSigner — ES256 issuance,
//                       JWKS endpoint, swap-token + id_token minting.
//  SHARED CONTRACTS:    cookie naming, the returnUrl/sync redirect contract, constants, and the
//                       session-revocation marker protocol (createSessionRegistry).
export { loadAuthEnv } from './env';
export type { AuthEnv } from './env';
export { createAuthVerifier } from './verify';
export type { AuthVerifier, AuthVerifierConfig } from './verify';
export { decodeLegacySessionCookie } from './legacy-cookie'; // read legacy next-auth civitai-token (no next-auth dep)
// Server-side consumer→hub clients (each file's header has the detail). All hub interaction goes through these,
// so app code never hand-rolls a hub fetch.
export { createSessionClient } from './session-client'; // token→user + invalidate/refresh
export type { SessionClient, SessionClientConfig } from './session-client';
export { createDeviceAccountClient } from './device-client'; // multi-account switching (cookie-forwarded)
export type { DeviceAccountClient, DeviceAccount } from './device-client';
export { createSessionTokenClient } from './session-token-client'; // rolling refresh + revoke
export type { SessionTokenClient } from './session-token-client';
export { createImpersonationClient } from './impersonation-client'; // moderator impersonate / exit
export type { ImpersonationClient } from './impersonation-client';
export { createExchangeClient } from './exchange-client'; // cross-domain swap-token → civ-token
export type { ExchangeClient } from './exchange-client';
export { createSessionSigner, maybeCreateSessionSigner } from './sign';
export type { SessionSigner, SessionSignerConfig } from './sign';
export { createAccountSwitchProvider } from './account-switch';
export type { AccountSwitchConfig } from './account-switch';
export { createAuthMiddleware } from './middleware';
export type { AuthMiddlewareConfig } from './middleware';
export {
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryConfig,
  type SessionRegistryRedis,
  type SessionKeys,
  type InvalidateInfo,
} from './session-registry';
export {
  cookiePrefix,
  isSecureCookie,
  sessionCookieName,
  deviceCookieName,
  legacySessionCookieName,
} from './cookies';
export {
  readReturnUrl,
  readSync,
  isSafeReturnTarget,
  buildPostLoginRedirect,
  type ReturnTargetOptions,
} from './redirect';
export * from './constants';
export type { SessionUser, SessionClaims } from './types';
