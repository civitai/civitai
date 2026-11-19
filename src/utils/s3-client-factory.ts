import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * The timeouts every server-side S3 client gets. The SDK sets no connect timeout and no socket timeout, so
 * an endpoint that accepts a connection and never answers holds the caller, and any retry loop above it,
 * indefinitely. Attempts stay at the SDK's default (3).
 *
 * - `connectionTimeoutMs`: waiting for a free socket in the client's pool PLUS establishing the TCP/TLS
 *   connection (smithy starts the timer before the agent hands out a socket). So the pool is sized well
 *   past smithy's default of 50 (`maxSockets`): with one memoised client per process, a burst past the
 *   pool would otherwise fail at this timeout instead of queueing.
 * - `requestTimeoutMs`: SOCKET INACTIVITY, not total duration (`@smithy/node-http-handler`
 *   `socket.setTimeout`). A large transfer that keeps moving bytes is never cut off; a stall of this long
 *   is, including a response body its consumer stops reading for that long.
 *
 * Off-switch: `S3_CLIENT_TIMEOUTS=off` (or `0` / `false`, any case) builds clients exactly as before this
 * change: no timeouts, no pool sizing, and — in s3-utils — a fresh client per call.
 * `apps/storage/src/lib/server/s3.ts` carries the same numbers and switch for the storage service.
 */
export const S3_CLIENT_BOUNDS = {
  connectionTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxSockets: 256,
};

export type S3ClientBounds = typeof S3_CLIENT_BOUNDS;

/** True when `S3_CLIENT_TIMEOUTS` is `off`, `0` or `false` (any case). Read per call. */
export function s3ClientTimeoutsOff(): boolean {
  return ['off', '0', 'false'].includes(
    (process.env.S3_CLIENT_TIMEOUTS ?? '').trim().toLowerCase()
  );
}

/**
 * Build an S3 client with {@link S3_CLIENT_BOUNDS}. Every server-side `S3Client` in the app is built here.
 * A caller's own `requestHandler` or `maxAttempts` wins (the retry-free probe client sets `maxAttempts: 1`).
 */
export function newS3Client(
  config: S3ClientConfig,
  bounds: Partial<S3ClientBounds> = {}
): S3Client {
  if (s3ClientTimeoutsOff()) return new S3Client(config);
  const { connectionTimeoutMs, requestTimeoutMs, maxSockets } = { ...S3_CLIENT_BOUNDS, ...bounds };
  return new S3Client({
    requestHandler: {
      connectionTimeout: connectionTimeoutMs,
      requestTimeout: requestTimeoutMs,
      httpAgent: { maxSockets },
      httpsAgent: { maxSockets },
    },
    ...config,
  });
}
