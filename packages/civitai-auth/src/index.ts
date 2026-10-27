// @civitai/auth — verify/receive SDK (Path C: asymmetric JWT + JWKS).
// See docs/auth-verification-strategy.md and docs/centralized-auth-app.md.
//
//  SPOKE (every app):   createAuthVerifier — local verify, no per-request hop.
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
export type { SessionTokenClient, RefreshFailure } from './session-token-client';
export { createImpersonationClient } from './impersonation-client'; // moderator impersonate / exit
export { probeInternalParity } from './hub'; // does the hub accept this app's service credential
export type { ImpersonationClient, ImpersonationResult } from './impersonation-client';
export { createSpokeGuard } from './spoke-guard'; // framework-agnostic first-party app session+role gate
export type {
  SpokeGuard,
  SpokeGuardCheckOptions,
  SpokeGuardConfig,
  SpokeGuardResult,
} from './spoke-guard';
export {
  spokeAuthorize,
  spokeCallback,
  spokeAuthorizeUrl,
  spokeReauthResponse,
  spokeSessionCookies,
  isNavigationRequest,
  withSetCookies,
  signInProblemHtml,
  POST_LOGIN_MARKER,
  LOGIN_RETRY_COOKIE,
  SESSION_REAUTH_HEADER,
} from './spoke-signin'; // a first-party app's own sign-in routes
export type { SpokeSignInEvent, SpokeSignInOptions, SpokeCallbackOptions } from './spoke-signin';
export { createRevocationCheck } from './revocation-check';
export type { RevocationCheckConfig } from './revocation-check';
export {
  buildAuthorizeRedirect,
  completeFirstPartyCallback,
  clearBridgeCookie,
  generatePkce,
  randomState,
  safePath,
  OAUTH_BRIDGE_COOKIE,
} from './first-party-bridge'; // framework-agnostic first-party login bridge (spoke side)
export type { AuthorizeRedirect, FirstPartyCallbackResult } from './first-party-bridge';
export { createSessionSigner, maybeCreateSessionSigner } from './sign';
export type { SessionSigner, SessionSignerConfig } from './sign';
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
export { SESSION_REGISTRY_KEYS } from './session-registry-keys';
export { familyId, familyClaims, SESSION_LINEAGE_MAX_AGE_MS } from './family';
export type { FamilyClaims } from './family';
export {
  cookiePrefix,
  isSecureCookie,
  sessionCookieName,
  deviceCookieName,
  legacySessionCookieName,
  allCookieNames,
  sessionCookieMode,
  legacyCookieReadEnabled,
  hostSessionCookieName,
  hostDeviceCookieName,
  sessionCookieNameForSlot,
  deviceCookieNameForSlot,
  readSessionToken,
  readDeviceId,
  rollSlot,
  parseCookieHeader,
  type CookieSlot,
  type CookieRead,
  type CookieReadOptions,
} from './cookies';
export {
  readReturnUrl,
  readSync,
  isSafeReturnTarget,
  isCivitaiOrigin,
  buildPostLoginRedirect,
  type ReturnTargetOptions,
} from './redirect';
export { safeReturnPath } from './return-path';
export {
  createTrustedDomainRegistry,
  type TrustedDomain,
  type TrustedDomainRegistry,
  type TrustedDomainRegistryConfig,
} from './trusted-domains';
export * from './constants';
export { firstPartyClientId, FIRST_PARTY_ID_PREFIX, SPOKE_CALLBACK_PATH } from './first-party'; // shared first-party client-id contract (hub + spoke; pure, browser-safe)
export { spokeLogout, spokeLogoutCookies } from './spoke-logout';
export type { SpokeLogoutOptions } from './spoke-logout';
export { hubLoginUrl, hubLogoutUrl, type ProviderId, type HubLoginUrlOptions } from './providers';
export { appRole, appRoles, hasAppRole, APP_ROLE_SEPARATOR } from './roles'; // app-namespaced role helpers (read SessionUser.roles by prefix)
export type { SessionUser, SessionClaims } from './types';
export * from './app-token';
