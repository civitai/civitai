import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * The timeouts every server-side S3 client gets. The SDK sets no connect timeout and no socket timeout, so
 * an endpoint that accepts a connection and never answers holds the caller, and any retry loop above it,
 * indefinitely. Attempts stay at the SDK's default (3).
 *
 * - `connectionTimeoutMs`: time to establish the TCP/TLS connection.
 * - `requestTimeoutMs`: SOCKET INACTIVITY, not total duration (`@smithy/node-http-handler`
 *   `socket.setTimeout`). A large transfer that keeps moving bytes is never cut off; a stall of this long
 *   is, including a response body its consumer stops reading for that long.
 *
 * Off-switch: `S3_CLIENT_TIMEOUTS=off` builds clients without them (the SDK's behaviour before this).
 * `apps/storage/src/lib/server/s3.ts` carries the same numbers and switch for the storage service.
 */
export const S3_CLIENT_BOUNDS = {
  connectionTimeoutMs: 3_000,
  requestTimeoutMs: 30_000,
};

export type S3ClientBounds = typeof S3_CLIENT_BOUNDS;

/**
 * Build an S3 client with {@link S3_CLIENT_BOUNDS}. Every server-side `S3Client` in the app is built here.
 * A caller's own `requestHandler` or `maxAttempts` wins (the retry-free probe client sets `maxAttempts: 1`).
 */
export function newS3Client(
  config: S3ClientConfig,
  bounds: S3ClientBounds = S3_CLIENT_BOUNDS
): S3Client {
  if (process.env.S3_CLIENT_TIMEOUTS === 'off') return new S3Client(config);
  return new S3Client({
    requestHandler: {
      connectionTimeout: bounds.connectionTimeoutMs,
      requestTimeout: bounds.requestTimeoutMs,
    },
    ...config,
  });
}
