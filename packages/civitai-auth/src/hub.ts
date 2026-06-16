import { loadAuthEnv } from './env';

/**
 * The hub origin (the token issuer, `AUTH_JWT_ISSUER`), trailing slashes stripped. Returns null when
 * unconfigured so callers can no-op a request path instead of throwing. Single source for the spoke→hub
 * clients (device / session-token / impersonation) + the session-client write path.
 */
export function hubBaseUrl(): string | null {
  const url = loadAuthEnv().AUTH_JWT_ISSUER;
  return url ? url.replace(/\/+$/, '') : null;
}
