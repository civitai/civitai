// Browser-safe entry (`@civitai/auth/client`): re-exports of the pure contracts (hub login-URL, shared constants,
// return-path rule) so client components never pull the main entry's server-only graph (session-registry →
// @civitai/redis → node:net) into the browser bundle. It makes no hub calls: browsers reach account and switch
// endpoints through their own app's same-origin /api/auth/* routes.
export { hubLoginUrl, hubLogoutUrl, type HubLoginUrlOptions } from './providers';
export * from './constants';
export { safeReturnPath } from './return-path';
export { readSessionToken, sessionCookieMode } from './cookies';

/** A linked account on the browser's device set — display only (mirrors the hub's `/api/auth/accounts` row). */
export interface DeviceAccountSummary {
  userId: number;
  username?: string;
  image?: string;
  lastSwitchedAt: number;
  active: boolean;
}
