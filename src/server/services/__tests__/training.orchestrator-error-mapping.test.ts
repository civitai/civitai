import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * training.service.toOrchestratorError fault classification (mirrors orchestrator
 * PR #2978, commit df625feef0).
 *
 * `toOrchestratorError` is the shared error mapper for the THREE training
 * orchestrator-submit points (getAutoLabelUploadUrl / submitAutoLabelWorkflow /
 * getAutoLabelWorkflow); it is only reached on a `!data` result from an
 * orchestrator round-trip. Its old `default` case threw a plain `Error`, so a
 * transient orchestrator 5xx (500/502/503/504) OR a status-less network/timeout
 * failure surfaced as a NON-retryable generic tRPC INTERNAL_SERVER_ERROR (500)
 * with an EMPTY cause chain — exactly the ~11×/2h masked "Internal Server Error"
 * seen on `training.submitAutoLabelWorkflow` in dp-prod (2026-07-09).
 *
 * The fix maps 5xx + status-less(undefined) → a retry-able SERVICE_UNAVAILABLE
 * (HTTP 503) with the ORIGINAL error preserved as `cause`, while keeping
 * 400/401/403/429 as-is and leaving any OTHER unexpected non-5xx status as a hard
 * error (so a genuine bug is NOT silently masked as a retry-able 503).
 *
 * The heavy training.service import graph (@aws-sdk, @civitai/client, orchestrator
 * caller, s3, redis, db) is stubbed so the module imports in node; the real
 * `~/server/utils/errorHandling` TRPCError mapping runs end-to-end (NOT mocked).
 * `handleError` (from the mocked @civitai/client) is given a small real-ish impl
 * so `messages` is a string, matching the production shape.
 */

// Heavy import-graph deps — trivial stubs so training.service imports in node.
// `handleError` derives the user-facing message string from the client error.
vi.mock('@civitai/client', () => ({
  handleError: vi.fn((e: unknown) => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      const rec = e as Record<string, unknown>;
      if (typeof rec.detail === 'string') return rec.detail;
      if (typeof rec.title === 'string') return rec.title;
    }
    return undefined;
  }),
}));
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/redis/client', () => ({
  REDIS_SYS_KEYS: { SYSTEM: { FEATURES: 'system:features' } },
  sysRedis: { hGet: vi.fn() },
  withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({ getOrchestratorCaller: vi.fn() }));

import { toOrchestratorError } from '~/server/services/training.service';

// toOrchestratorError has a `never` return — capture the thrown value.
const capture = (error: unknown): unknown => {
  try {
    toOrchestratorError(error);
    return undefined;
  } catch (e) {
    return e;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toOrchestratorError — transient upstream failures → retry-able 503 (mirror #2978)', () => {
  it.each([500, 502, 503, 504])(
    'maps an orchestrator HTTP %i to SERVICE_UNAVAILABLE (503), NOT a plain Error / generic 500',
    (status) => {
      const upstreamError = { status, detail: 'orchestrator exploded' };
      const err = capture(upstreamError);

      expect(err).toBeInstanceOf(TRPCError);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
      // Item B: the ORIGINAL client error is preserved on `.cause` (was masked/empty).
      // (TRPCError wraps a non-Error cause into an Error that copies its props, so
      // assert structurally — same shape as #2978's submitWorkflow.error-mapping test.)
      expect((err as TRPCError).cause).toMatchObject({ status, detail: 'orchestrator exploded' });
    }
  );

  it('maps a status-less network/timeout error (status undefined) to SERVICE_UNAVAILABLE (503)', () => {
    // A TCP/DNS/TLS failure reaches the client as a bare Error with no `status`.
    const networkError = new Error('fetch failed');
    const err = capture(networkError);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toBe(networkError);
  });

  it('maps a client error object with an undefined status field to 503', () => {
    // `{ status: undefined }` (a resolve shape with no HTTP status) still routes to
    // the transient branch, not the hard-error anomaly branch.
    const err = capture({ status: undefined, detail: 'no response' });
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('toOrchestratorError — client/rate faults are unchanged (NOT converted to 503)', () => {
  it('keeps status 400 as BAD_REQUEST', () => {
    const err = capture({ status: 400, detail: 'bad input' });
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('keeps status 401 as UNAUTHORIZED', () => {
    const err = capture({ status: 401, detail: 'no token' });
    expect((err as TRPCError).code).toBe('UNAUTHORIZED');
  });

  it('keeps status 403 as UNAUTHORIZED (existing throwAuthorizationError behavior)', () => {
    const err = capture({ status: 403, detail: 'forbidden' });
    expect((err as TRPCError).code).toBe('UNAUTHORIZED');
  });

  it('keeps status 429 as TOO_MANY_REQUESTS', () => {
    const err = capture({ status: 429, detail: 'slow down' });
    expect((err as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('toOrchestratorError — an unexpected non-5xx anomaly stays a hard error (no over-broad 503)', () => {
  it('an unexpected 4xx status (418) stays a plain Error, NOT a 503', () => {
    // Only recognized transient failures (5xx + status-less) become 503; a real,
    // non-transient anomaly must remain visible as a hard error so a genuine bug is
    // not silently masked as retry-able.
    const err = capture({ status: 418, detail: 'teapot' });

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBeUndefined();
  });
});
