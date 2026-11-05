/** Shared secret for the search API. Empty = gate disabled (dev only). */
export const searchToken = process.env.SEARCH_TOKEN ?? '';

export const port = Number(process.env.PORT ?? 3000);
export const host = process.env.HOST ?? '0.0.0.0';
export const logLevel = process.env.LOG_LEVEL ?? 'info';
export const isProd = process.env.NODE_ENV === 'production';

/** Fail-fast boot validation, called from server.ts before listen (tests import app.ts and skip it). */
export function assertRequiredEnv() {
  const missing: string[] = [];
  if (!process.env.QDRANT_URL) missing.push('QDRANT_URL');
  if (!process.env.ORCHESTRATOR_ENDPOINT) missing.push('ORCHESTRATOR_ENDPOINT');
  if (!process.env.ORCHESTRATOR_ACCESS_TOKEN) missing.push('ORCHESTRATOR_ACCESS_TOKEN');
  if (isProd && !searchToken) missing.push('SEARCH_TOKEN (required in production)');
  if (!!process.env.REDIS_URL !== !!process.env.REDIS_SYS_URL)
    missing.push('REDIS_URL and REDIS_SYS_URL (both or neither)');
  if (missing.length) throw new Error(`[search] missing required env: ${missing.join(', ')}`);
}
