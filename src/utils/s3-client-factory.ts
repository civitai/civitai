import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * The bounds every server-side S3 client gets. The SDK's own defaults are no connect timeout, no socket
 * timeout and 3 attempts, so an endpoint that accepts a connection and never answers holds the caller, and
 * any retry loop above it, indefinitely.
 *
 * - `connectionTimeoutMs`: time to establish the TCP/TLS connection.
 * - `requestTimeoutMs`: SOCKET INACTIVITY, not total duration (`@smithy/node-http-handler`
 *   `socket.setTimeout`). A large transfer that keeps moving bytes is never cut off; a stall of this long
 *   is, including a response body its consumer stops reading for that long.
 * - `maxAttempts`: one retry. Callers that loop add their own on top.
 *
 * `apps/storage/src/lib/server/s3.ts` carries the same numbers for the storage service.
 */
export const S3_CLIENT_BOUNDS = {
  connectionTimeoutMs: 3_000,
  requestTimeoutMs: 30_000,
  maxAttempts: 2,
};

export type S3ClientBounds = typeof S3_CLIENT_BOUNDS;

/**
 * Build an S3 client with {@link S3_CLIENT_BOUNDS}. Every server-side `S3Client` in the app is built here.
 * A caller's own `maxAttempts` or `requestHandler` wins (the retry-free probe client sets `maxAttempts: 1`).
 */
export function newS3Client(
  config: S3ClientConfig,
  bounds: S3ClientBounds = S3_CLIENT_BOUNDS
): S3Client {
  return new S3Client({
    maxAttempts: bounds.maxAttempts,
    requestHandler: {
      connectionTimeout: bounds.connectionTimeoutMs,
      requestTimeout: bounds.requestTimeoutMs,
    },
    ...config,
  });
}
