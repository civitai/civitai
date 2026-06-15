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
// Consumer SESSION CLIENT (server side — pulls @civitai/redis + fetch). Zero-config, one builder for the
// whole consumer session surface: getSessionUser (read: verify → shared cache → hub on miss) +
// invalidate/refresh (write: routed through the hub). The hub is the sole producer; nothing is injectable.
// See docs/thin-session-token-design.md ("LOCKED ARCHITECTURE").
export { createSessionClient } from './session-client';
export type { SessionClient } from './session-client';
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
export { cookiePrefix, isSecureCookie, sessionCookieName, deviceCookieName } from './cookies';
export {
  readReturnUrl,
  readSync,
  isSafeReturnTarget,
  buildPostLoginRedirect,
  type ReturnTargetOptions,
} from './redirect';
export * from './constants';
export type { SessionUser, SessionClaims } from './types';
