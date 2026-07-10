import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Error mapping for orchestrator.imageUpload (imageUpload.ts).
 *
 * Drives the REAL `imageUpload` through its `if (!data)` → `switch (status)`
 * branches, mocking ONLY the generated `@civitai/client` + the client factory so
 * the real `~/server/utils/errorHandling` TRPCError mapping AND the real
 * `~/shared/constants/orchestrator.constants` `isMature` run end-to-end.
 *
 * The bug this covers (masked causeless generic 500s — the #1 dp-prod 500 source
 * at ~178/h and climbing, 2026-07-10):
 *  - The `switch (error.status)` `default` case threw a plain `Error`, so an
 *    upstream orchestrator HTTP 5xx (500/502/503/504) OR a status-less
 *    network/timeout failure (no HTTP status) surfaced as a generic tRPC
 *    INTERNAL_SERVER_ERROR (500) with an EMPTY cause chain — INVISIBLE in
 *    `_axiom` and non-retryable. Now mapped to a retry-able SERVICE_UNAVAILABLE
 *    (503) with the ORIGINAL client error preserved as `cause` (mirror #3047 /
 *    #2978).
 *  - The mature-content rejection (`allowMatureContent === false` + a mature
 *    blob) threw a plain `Error('mature content not allowed')` → a 500 for what is
 *    a USER-CONTENT rejection. Now a 400 BAD_REQUEST.
 */

const { mockInvokeImageUploadStepTemplate } = vi.hoisted(() => ({
  mockInvokeImageUploadStepTemplate: vi.fn(),
}));

// NsfwLevel + WorkflowStatus are read at module-load by orchestrator.constants; give
// them real-ish string enums so `isMature` runs against the SAME values as the test.
vi.mock('@civitai/client', () => ({
  invokeImageUploadStepTemplate: mockInvokeImageUploadStepTemplate,
  // handleError derives the fallback user-facing message string from the client error.
  handleError: vi.fn((e: unknown) => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      const rec = e as Record<string, unknown>;
      if (typeof rec.detail === 'string') return rec.detail;
      if (typeof rec.title === 'string') return rec.title;
    }
    return undefined;
  }),
  NsfwLevel: { PG: 'PG', PG13: 'PG13', R: 'R', X: 'X', XXX: 'XXX' },
  WorkflowStatus: {
    UNASSIGNED: 'unassigned',
    PREPARING: 'preparing',
    SCHEDULED: 'scheduled',
    PROCESSING: 'processing',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    EXPIRED: 'expired',
    CANCELED: 'canceled',
  },
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

import { imageUpload } from '~/server/services/orchestrator/imageUpload';

// A resolve shape (NOT a reject): the @civitai/client with no `throwOnError` RESOLVES
// `{ data: undefined, error }` on an upstream error response.
const errorResolve = (error: unknown) => ({ data: undefined, error });

const run = (allowMatureContent?: boolean) =>
  imageUpload({ sourceImage: 'https://x/y.png', token: 'tok', allowMatureContent }).catch(
    (e) => e
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('imageUpload — transient upstream failures → retry-able 503, cause preserved', () => {
  it.each([500, 502, 503, 504])(
    'maps an orchestrator HTTP %i to SERVICE_UNAVAILABLE (503), NOT a plain Error / generic 500',
    async (status) => {
      mockInvokeImageUploadStepTemplate.mockResolvedValue(
        errorResolve({ status, detail: 'orchestrator exploded' })
      );

      const err = await run();

      expect(err).toBeInstanceOf(TRPCError);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
      // The ORIGINAL client error is preserved on `.cause` (was masked/empty before).
      expect((err as TRPCError).cause).toMatchObject({ status, detail: 'orchestrator exploded' });
    }
  );

  it('maps a status-less network/timeout error (bare Error, no status) to SERVICE_UNAVAILABLE (503)', async () => {
    // A TCP/DNS/TLS failure reaches the client as a bare Error with no `status`.
    const networkError = new Error('fetch failed');
    mockInvokeImageUploadStepTemplate.mockResolvedValue(errorResolve(networkError));

    const err = await run();

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toBe(networkError);
  });

  it('maps a client error object with an undefined status field to 503', async () => {
    mockInvokeImageUploadStepTemplate.mockResolvedValue(
      errorResolve({ status: undefined, detail: 'no response' })
    );

    const err = await run();
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('imageUpload — client faults are unchanged (NOT converted to 503)', () => {
  it('keeps status 400 as BAD_REQUEST', async () => {
    mockInvokeImageUploadStepTemplate.mockResolvedValue(
      errorResolve({ status: 400, detail: 'bad input' })
    );

    const err = await run();
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('keeps status 401 as UNAUTHORIZED', async () => {
    mockInvokeImageUploadStepTemplate.mockResolvedValue(
      errorResolve({ status: 401, detail: 'no token' })
    );

    const err = await run();
    expect((err as TRPCError).code).toBe('UNAUTHORIZED');
  });
});

describe('imageUpload — an unexpected non-5xx anomaly stays a hard error (no over-broad 503)', () => {
  it('an unexpected 4xx status (418) stays a plain Error, NOT a 503', async () => {
    mockInvokeImageUploadStepTemplate.mockResolvedValue(
      errorResolve({ status: 418, detail: 'teapot' })
    );

    const err = await run();

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBeUndefined();
  });
});

describe('imageUpload — mature-content rejection is a 400 BAD_REQUEST, not a 500', () => {
  it('rejects a mature blob when allowMatureContent === false with BAD_REQUEST', async () => {
    // data present (success round-trip) but a mature nsfwLevel → user-content reject.
    mockInvokeImageUploadStepTemplate.mockResolvedValue({
      data: { blob: { nsfwLevel: 'R' } },
      error: undefined,
    });

    const err = await run(false);

    expect(err).toBeInstanceOf(TRPCError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect((err as TRPCError).message).toMatch(/mature content not allowed/i);
  });

  it('returns data untouched on the success path (safe blob)', async () => {
    const data = { blob: { nsfwLevel: 'PG' } };
    mockInvokeImageUploadStepTemplate.mockResolvedValue({ data, error: undefined });

    const result = await imageUpload({
      sourceImage: 'https://x/y.png',
      token: 'tok',
      allowMatureContent: false,
    });
    expect(result).toBe(data);
  });

  it('returns a mature blob untouched when allowMatureContent is not false', async () => {
    const data = { blob: { nsfwLevel: 'R' } };
    mockInvokeImageUploadStepTemplate.mockResolvedValue({ data, error: undefined });

    const result = await imageUpload({ sourceImage: 'https://x/y.png', token: 'tok' });
    expect(result).toBe(data);
  });
});
