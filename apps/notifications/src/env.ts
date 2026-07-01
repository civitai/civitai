// App-local env accessors. The @civitai/* packages own + validate their OWN env slices (postgres via
// @civitai/db, redis via @civitai/redis, axiom via @civitai/axiom) on first client build — this file
// only holds the config that is the APP's own, not a package's.

export const signalsEndpoint = process.env.SIGNALS_ENDPOINT ?? '';

/** Shared secret for the producer API. Empty = gate disabled (dev only). */
export const notificationsToken = process.env.NOTIFICATIONS_TOKEN ?? '';

export const port = Number(process.env.PORT ?? 3000);
export const host = process.env.HOST ?? '0.0.0.0';
export const logLevel = process.env.LOG_LEVEL ?? 'info';
export const isProd = process.env.NODE_ENV === 'production';
