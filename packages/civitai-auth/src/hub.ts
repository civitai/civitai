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

/**
 * STRICT hub fetch — the server-side primitive every spoke→hub client routes through, so the package provably
 * only ever talks to the hub (`AUTH_JWT_ISSUER`), never a relative/spoke path. Throws if the hub isn't
 * configured; callers wrap in try/catch and fall back to their own empty/null result.
 */
export function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = hubBaseUrl();
  if (!base) throw new Error('[@civitai/auth] hub not configured (AUTH_JWT_ISSUER)');
  return fetch(`${base}${path}`, init);
}
