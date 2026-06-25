import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock ONLY the generated client + the orchestrator client factory + env so we can
// drive `submitWorkflow` through its retry / error branches. The real
// `~/server/utils/errorHandling` loads so the actual TRPCError mapping + the
// `isUpstreamNetworkError` classification (TimeoutError → 503) are exercised.
const { mockSubmitWorkflow, mockHandleError } = vi.hoisted(() => ({
  mockSubmitWorkflow: vi.fn(),
  mockHandleError: vi.fn(() => 'orchestrator error'),
}));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  handleError: mockHandleError,
  // unused-by-these-tests named exports referenced at module load
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';

const baseBody = { steps: [] } as any;

// A failing 5xx client result (no data, response status 500) — the retry-able shape.
const fail5xx = () => ({ data: undefined, error: { errors: {} }, response: { status: 500 } });
// A successful client result.
const ok = () => ({ data: { id: 'wf-ok' }, response: { status: 200 } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitWorkflow — whatIf path (maxAttempts: 1, no retry)', () => {
  it('does NOT retry a 5xx — calls the client exactly once and surfaces the error fast', async () => {
    mockSubmitWorkflow.mockResolvedValue(fail5xx());

    const err = await submitWorkflow({
      token: 'tok',
      body: baseBody,
      query: { whatif: true },
      maxAttempts: 1,
    }).catch((e) => e);

    // The crux: a transient orchestrator 5xx is surfaced after a SINGLE attempt, not
    // amplified 3× (the ~93s prod symptom). A 500 status maps to INTERNAL_SERVER_ERROR.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('does NOT retry a status-less network rejection — single attempt, mapped to 503', async () => {
    // A bounded caller (maxAttempts set) remaps a recognized network throw to 503.
    mockSubmitWorkflow.mockRejectedValue(new TypeError('fetch failed'));

    const err = await submitWorkflow({
      token: 'tok',
      body: baseBody,
      query: { whatif: true },
      maxAttempts: 1,
    }).catch((e) => e);

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('submitWorkflow — write/generate path (no new options, UNCHANGED)', () => {
  it('still retries up to 3× on a persistent 5xx', async () => {
    mockSubmitWorkflow.mockResolvedValue(fail5xx());

    const err = await submitWorkflow({ token: 'tok', body: baseBody }).catch((e) => e);

    // Write path keeps its 3-attempt behavior (default maxAttempts=3).
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(TRPCError);
  });

  it('succeeds after a transient 5xx is retried (recovers on attempt 2)', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce(fail5xx()).mockResolvedValueOnce(ok());

    const data = await submitWorkflow({ token: 'tok', body: baseBody });

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    expect(data).toEqual({ id: 'wf-ok' });
  });

  it('a raw network throw propagates UNCHANGED (no 503 remap, no TRPCError) on the write path', async () => {
    // Guard: without the new options, `boundedCaller` is false → the throw must
    // bubble byte-identically to before (the retry wrapper re-throws the last error
    // after exhausting attempts; no network→503 remap is applied here).
    const networkThrow = new TypeError('fetch failed');
    mockSubmitWorkflow.mockRejectedValue(networkThrow);

    const err = await submitWorkflow({ token: 'tok', body: baseBody }).catch((e) => e);

    // 3 attempts (the wrapper retries a thrown network error), then the raw error
    // bubbles — NOT mapped to a TRPCError/503 the way a bounded caller would.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
    expect(err).toBe(networkThrow);
    expect(err).not.toBeInstanceOf(TRPCError);
  });
}, 20_000);

describe('submitWorkflow — timeout budget (bounded caller)', () => {
  it('maps a fired TimeoutError to SERVICE_UNAVAILABLE (503)', async () => {
    // Simulate AbortSignal.timeout firing: the fetch rejects with a TimeoutError.
    // `isUpstreamNetworkError` matches `name === 'TimeoutError'` → 503 remap because
    // the caller provided timeoutMs/maxAttempts (boundedCaller=true).
    const timeoutErr = Object.assign(new Error('The operation timed out.'), {
      name: 'TimeoutError',
    });
    mockSubmitWorkflow.mockRejectedValue(timeoutErr);

    const err = await submitWorkflow({
      token: 'tok',
      body: baseBody,
      query: { whatif: true },
      maxAttempts: 1,
      timeoutMs: 30_000,
    }).catch((e) => e);

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toBe(timeoutErr);
  });

  it('threads an AbortSignal to the client only when timeoutMs is set', async () => {
    mockSubmitWorkflow.mockResolvedValue(ok());

    await submitWorkflow({ token: 'tok', body: baseBody, query: { whatif: true }, timeoutMs: 5_000 });
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

    mockSubmitWorkflow.mockClear();

    // Write path: no timeoutMs → no signal threaded (behaviorally identical).
    await submitWorkflow({ token: 'tok', body: baseBody });
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeUndefined();
  });
});
