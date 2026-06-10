// @civitai/auth — verify/receive SDK (Path C: asymmetric JWT + JWKS).
// See docs/auth-verification-strategy.md and docs/centralized-auth-app.md.
//
//  SPOKE (every app):   createAuthVerifier — local verify, no per-request hop.
//                       createAccountSwitchProvider — cross-root session receiver.
//                       createAuthMiddleware — edge route guard.
//  HUB   (apps/auth):    createSessionSigner / maybeCreateSessionSigner — RS256 issuance,
//                       JWKS endpoint, swap-token + id_token minting.
//  SHARED CONTRACTS:    cookie naming, the returnUrl/sync redirect contract, constants, and the
//                       session-revocation marker protocol (createSessionRegistry).
export { loadAuthEnv } from './env';
export type { AuthEnv } from './env';
export { createAuthVerifier } from './verify';
export type { AuthVerifier, AuthVerifierConfig } from './verify';
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
export { cookiePrefix, sessionCookieName } from './cookies';
export {
  readReturnUrl,
  readSync,
  isSafeReturnTarget,
  buildPostLoginRedirect,
  type ReturnTargetOptions,
} from './redirect';
export * from './constants';
export type { SessionUser, SessionClaims } from './types';
