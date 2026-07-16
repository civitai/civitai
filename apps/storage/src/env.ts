// App-local env accessors. The S3 backend CREDENTIALS are read per-backend in lib/server/backends.ts
// (analogous to how apps/notifications reads DB creds in clients/db.ts); this file holds only the
// app's own service config.

/** Shared secret for the storage API. Empty = gate disabled (dev only). */
export const storageToken = process.env.STORAGE_TOKEN ?? '';

export const port = Number(process.env.PORT ?? 3000);
export const host = process.env.HOST ?? '0.0.0.0';
export const logLevel = process.env.LOG_LEVEL ?? 'info';
export const isProd = process.env.NODE_ENV === 'production';

/**
 * Fail-fast boot validation. Called from server.ts BEFORE listen (not from buildServer, so vitest —
 * which imports app.ts — is unaffected). At minimum the DEFAULT backend (R2 main content bucket) must be
 * configured, since every app relies on it; other backends fail lazily on first use with a clear error.
 * In prod the API must be authed — an empty token disables the gate (see auth.ts).
 */
export function assertRequiredEnv() {
  const missing: string[] = [];
  if (!process.env.S3_UPLOAD_ENDPOINT) missing.push('S3_UPLOAD_ENDPOINT');
  if (!process.env.S3_UPLOAD_KEY) missing.push('S3_UPLOAD_KEY');
  if (!process.env.S3_UPLOAD_SECRET) missing.push('S3_UPLOAD_SECRET');
  if (isProd && !storageToken) missing.push('STORAGE_TOKEN (required in production)');

  if (missing.length) {
    throw new Error(`[storage] missing required env: ${missing.join(', ')}`);
  }
}
