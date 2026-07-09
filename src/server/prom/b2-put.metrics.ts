import client from 'prom-client';
// Type-only: erased at compile time, so this module stays a runtime-pure prom-client
// leaf (the unit test never loads the AWS SDK).
import type { S3Client } from '@aws-sdk/client-s3';

/**
 * BACKBLAZE B2 PUT observability (additive telemetry only — no behavior change).
 *
 * Civitai's B2 account is contracted for a 3,000 PUT-RPS ceiling and the main app
 * is the dominant, previously-uninstrumented source. This module emits the
 * CROSS-SERVICE CANONICAL counters (shared verbatim with image-cacher +
 * orchestration + the DR-mirror Pushgateway jobs and read by the `B2 PUT Load`
 * Grafana dashboard / alerts), so the metric NAMES here are intentionally NOT
 * `PROM_PREFIX`-prefixed — they must match the identical names on every service:
 *
 *   b2_put_requests_total{service="civitai-web", bucket, op, result}
 *       op     ∈ {upload, copy, multipart}
 *       result ∈ {success, throttled, error}
 *   b2_put_retries_total{service="civitai-web", bucket}
 *   b2_presign_issued_total{service="civitai-web", bucket}   (civitai-web-only proxy — see below)
 *
 * SERVER-side coverage is via an AWS-SDK v3 client middleware installed on the two
 * B2 S3 client factories (`getB2S3Client` / `getB2ImageS3Client` in s3-utils.ts).
 * Because the middleware runs at the `initialize` step it fires once per `.send()`
 * with the FINAL outcome (post-retry), and it NEVER runs for presigned URLs —
 * `getSignedUrl` does not call `.send()`. This gives us exactly the server-side /
 * browser-direct split we want. Retry attempts are read from `$metadata.attempts`
 * on the resolved output (or the thrown error), so retries ARE observable without a
 * per-attempt middleware.
 *
 * BROWSER-DIRECT uploads (presigned model-file / media PUTs) upload from the user's
 * browser IP, so the actual PUT is invisible pod-side. We count ISSUANCE of the
 * presigned URL as a proxy via `b2_presign_issued_total` — a DEDICATED counter, not
 * a `b2_put_requests_total{op="presign"}` row, deliberately: the dashboard's
 * headline sums `b2_put_requests_total` as real PUT RPS against the 3,000 ceiling,
 * and folding non-PUT issuance into that name would inflate the ceiling gauge.
 *
 * Registered on the DEFAULT prom-client registry (scraped at /api/metrics) and
 * pinned on globalThis so HMR / a second webpack-graph eval reuse the one instance
 * instead of tripping prom-client's duplicate-registration throw (same pattern as
 * dev-tunnel.metrics.ts / the http-error counter).
 */

export const B2_PUT_SERVICE = 'civitai-web';

export type B2PutOp = 'upload' | 'copy' | 'multipart';
export type B2PutResult = 'success' | 'throttled' | 'error';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiB2PutMetrics:
    | {
        requests: client.Counter<string>;
        retries: client.Counter<string>;
        presignIssued: client.Counter<string>;
      }
    | undefined;
}

const metrics =
  globalThis.__civitaiB2PutMetrics ??
  (globalThis.__civitaiB2PutMetrics = {
    requests: new client.Counter({
      name: 'b2_put_requests_total',
      help:
        'Server-side Backblaze B2 PUT-class transactions issued by this pod, by op ' +
        '(upload|copy|multipart) and result (success|throttled|error). Counts once per ' +
        '.send() (final post-retry outcome). Excludes browser-direct presigned uploads.',
      labelNames: ['service', 'bucket', 'op', 'result'],
    }),
    retries: new client.Counter({
      name: 'b2_put_retries_total',
      help:
        'SDK retry attempts made on server-side B2 PUT-class sends (attempts-1, from ' +
        '$metadata.attempts). Monotonic; use rate().',
      labelNames: ['service', 'bucket'],
    }),
    presignIssued: new client.Counter({
      name: 'b2_presign_issued_total',
      help:
        'Presigned B2 PUT/UploadPart URLs ISSUED to browsers (proxy for browser-direct ' +
        'upload load — the actual PUT happens from the user IP and is invisible pod-side). ' +
        'NOT a real PUT; kept out of b2_put_requests_total on purpose.',
      labelNames: ['service', 'bucket'],
    }),
  });

/** Map an AWS-SDK command name to the canonical `op`, or null for commands we do
 *  not count (Get/Head/Delete/Complete/Abort — not PUT-class transactions). */
export function opForCommand(commandName: string | undefined): B2PutOp | null {
  switch (commandName) {
    case 'PutObjectCommand':
      return 'upload';
    case 'CopyObjectCommand':
      return 'copy';
    case 'CreateMultipartUploadCommand':
    case 'UploadPartCommand':
      return 'multipart';
    default:
      return null;
  }
}

const THROTTLE_ERROR_NAMES = new Set([
  'SlowDown',
  'TooManyRequests',
  'TooManyRequestsException',
  'ThrottlingException',
  'Throttling',
  'RequestThrottled',
  'RequestThrottledException',
  'ProvisionedThroughputExceededException',
]);

/** Classify a thrown SDK error as `throttled` (HTTP 429, or 503 SlowDown/
 *  TooManyRequests / other throttle codes) vs a generic `error`. */
export function classifyErrorResult(error: unknown): Extract<B2PutResult, 'throttled' | 'error'> {
  const e = error as
    | { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
    | undefined;
  const status = e?.$metadata?.httpStatusCode;
  if (status === 429) return 'throttled';
  const code = e?.name ?? e?.Code;
  if (code && THROTTLE_ERROR_NAMES.has(code)) return 'throttled';
  return 'error';
}

function retriesFromMetadata(metadata: { attempts?: number } | undefined): number {
  const attempts = metadata?.attempts;
  if (typeof attempts === 'number' && attempts > 1) return attempts - 1;
  return 0;
}

/** Record one server-side B2 PUT-class send outcome. Never throws — a telemetry
 *  failure must not break an upload. Exported for direct unit testing. */
export function recordB2PutSend(args: {
  bucket: string | undefined;
  op: B2PutOp;
  result: B2PutResult;
  retries?: number;
}): void {
  try {
    const bucket = args.bucket ?? 'unknown';
    metrics.requests.inc({ service: B2_PUT_SERVICE, bucket, op: args.op, result: args.result });
    if (args.retries && args.retries > 0) {
      metrics.retries.inc({ service: B2_PUT_SERVICE, bucket }, args.retries);
    }
  } catch {
    /* never throw from telemetry */
  }
}

/** Record issuance of a presigned browser-direct B2 PUT URL. Never throws. */
export function recordB2PresignIssued(bucket: string | undefined): void {
  try {
    metrics.presignIssued.inc({ service: B2_PUT_SERVICE, bucket: bucket ?? 'unknown' });
  } catch {
    /* never throw from telemetry */
  }
}

// Minimal structural shapes so this module needs no @aws-sdk/@smithy type deps.
type B2Metadata = { attempts?: number; httpStatusCode?: number };
type B2MiddlewareArgs = { input?: { Bucket?: string } };
type B2MiddlewareOutput = { output?: { $metadata?: B2Metadata } };
type B2NextHandler = (args: B2MiddlewareArgs) => Promise<B2MiddlewareOutput>;
type B2MiddlewareContext = { commandName?: string };

/**
 * AWS-SDK v3 `initialize`-step middleware that counts B2 PUT-class sends. Exported
 * raw (curried `(next, context) => handler`) so unit tests can drive it directly.
 * Passes non-PUT-class commands straight through untouched.
 */
export const b2PutMetricsMiddleware =
  (next: B2NextHandler, context: B2MiddlewareContext) => async (args: B2MiddlewareArgs) => {
    const op = opForCommand(context?.commandName);
    if (!op) return next(args);
    const bucket = args?.input?.Bucket;
    try {
      const result = await next(args);
      // Guard the WHOLE telemetry expression — including the retriesFromMetadata
      // argument evaluation — so no telemetry helper can throw into a successful
      // upload's return path. (recordB2PutSend also self-guards; this makes the
      // "telemetry never throws into an upload" guarantee structural, not just
      // empirical about which helpers currently can throw.)
      try {
        recordB2PutSend({
          bucket,
          op,
          result: 'success',
          retries: retriesFromMetadata(result?.output?.$metadata),
        });
      } catch {
        /* never throw from telemetry */
      }
      return result;
    } catch (error) {
      // Guard telemetry (classifyErrorResult + retriesFromMetadata arg evaluation)
      // so the ORIGINAL SDK error is always the one re-thrown, never a telemetry error.
      try {
        recordB2PutSend({
          bucket,
          op,
          result: classifyErrorResult(error),
          retries: retriesFromMetadata((error as { $metadata?: B2Metadata })?.$metadata),
        });
      } catch {
        /* never throw from telemetry */
      }
      throw error;
    }
  };

// Track instrumented clients so re-wrapping a memoized client is a no-op.
const instrumentedClients = new WeakSet<object>();

/**
 * Install the B2 PUT metrics middleware on an AWS-SDK v3 S3Client and return it.
 * Idempotent per client instance. Typed loosely (`middlewareStack.add` is heavily
 * overloaded on the S3 service union) — the middleware itself is fully structural.
 */
export function instrumentB2Client(s3: S3Client): S3Client {
  try {
    if (instrumentedClients.has(s3)) return s3;
    // `middlewareStack.add` is overloaded per step; the `step: 'initialize'` option
    // selects the initialize overload. The middleware is structurally typed (no SDK
    // deps), so cast it past the overload's strict generic signature.
    s3.middlewareStack.add(b2PutMetricsMiddleware as never, {
      step: 'initialize',
      name: 'civitaiB2PutMetrics',
      tags: ['B2_PUT_METRICS'],
      override: true,
    });
    instrumentedClients.add(s3);
  } catch {
    /* never let instrumentation break client construction */
  }
  return s3;
}

/** Test-only: reset all B2 PUT counters between cases. */
export function __resetB2PutMetricsForTest(): void {
  metrics.requests.reset();
  metrics.retries.reset();
  metrics.presignIssued.reset();
}
