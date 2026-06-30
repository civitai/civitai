import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock ONLY the generated client + the orchestrator client factory + env so we can drive
// `submitWorkflow` / `submitWorkflowWithRetry` through their retry + error branches. The
// real `~/server/utils/errorHandling` loads so the actual TRPCError mapping
// (isUpstreamNetworkError → throwServiceUnavailableError) is exercised end-to-end.
const { mockSubmitWorkflow } = vi.hoisted(() => ({
  mockSubmitWorkflow: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  // unused-by-these-tests named exports referenced at module load
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : 'err')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import {
  submitWorkflow,
  submitWorkflowWithRetry,
} from '~/server/services/orchestrator/workflows';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// A TimeoutError as a fired AbortSignal.timeout() surfaces it (named 'TimeoutError').
// isUpstreamNetworkError matches `.name === 'TimeoutError'`.
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// The REAL `@civitai/client` shape on a fetch failure / fired AbortSignal.timeout.
// `createOrchestratorClient` does NOT set `throwOnError`, so the client RESOLVES with
// `{ error, response: undefined }` — it does NOT reject. Tests that mock the abort path
// MUST use this shape, not `mockRejectedValue`, or they exercise a branch the real
// client never reaches.
const timeoutResolveResult = () => ({
  data: undefined,
  response: undefined,
  error: timeoutError(),
});

const okResult = (id = 'wf-1') => ({ data: { id }, response: { status: 200 } });

describe('submitWorkflowWithRetry — per-attempt timeout', () => {
  it('fires the per-attempt timeout on a hanging attempt, retries with a FRESH deadline, and honors maxAttempts', async () => {
    // Every attempt "times out". The REAL client (no throwOnError) RESOLVES with
    // `{ error, response: undefined }` on a fired AbortSignal.timeout — it does NOT
    // reject. A status-less, data-less result is `retryable`, so the wrapper backs off
    // and retries, then RETURNS the final attempt's result (it does NOT throw). A hang
    // on attempt 1 must NOT consume attempt 2's budget (each gets a fresh signal).
    mockSubmitWorkflow.mockResolvedValue(timeoutResolveResult());

    const result = await submitWorkflowWithRetry(
      { client: {} as any, body: {} as any, query: { whatif: true } as any },
      { maxAttempts: 3, baseDelayMs: 1, perAttemptTimeoutMs: 8_000 }
    );

    // The wrapper RETURNS the final resolve shape (status-less, data-less) — it does NOT
    // throw on the resolve path. Classification to 503 happens in `submitWorkflow`.
    expect(result.data).toBeUndefined();
    expect(result.response).toBeUndefined();
    expect((result.error as Error).name).toBe('TimeoutError');
    expect(result.attempts).toBe(3);
    // Each attempt got its own (fresh) deadline → all 3 attempts were made.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
    // A FRESH AbortSignal per attempt: the signals passed on attempt 1 vs 2 differ.
    const sig1 = mockSubmitWorkflow.mock.calls[0][0].signal;
    const sig2 = mockSubmitWorkflow.mock.calls[1][0].signal;
    expect(sig1).toBeInstanceOf(AbortSignal);
    expect(sig2).toBeInstanceOf(AbortSignal);
    expect(sig1).not.toBe(sig2);
  });

  it('a transient hang on attempt 1 then success on attempt 2 returns success (retry preserved)', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(timeoutResolveResult())
      .mockResolvedValueOnce(okResult('wf-ok'));

    const result = await submitWorkflowWithRetry(
      { client: {} as any, body: {} as any, query: { whatif: true } as any },
      { maxAttempts: 3, baseDelayMs: 1, perAttemptTimeoutMs: 8_000 }
    );

    expect(result.data).toEqual({ id: 'wf-ok' });
    expect(result.attempts).toBe(2);
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
  });

  it('does NOT thread any signal when perAttemptTimeoutMs is omitted (generate/write path is unchanged)', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflowWithRetry({ client: {} as any, body: {} as any, query: {} as any });

    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeUndefined();
  });
});

describe('submitWorkflow — whatIf per-attempt timeout → 503, generate untouched', () => {
  // Backoff uses real setTimeout; skip it deterministically with fake timers so the
  // ~2s of real backoff doesn't slow the suite.
  const runWithFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    const p = fn();
    await vi.runAllTimersAsync();
    return p;
  };

  it('maps an exhausted whatIf per-attempt timeout (REAL resolve shape) to SERVICE_UNAVAILABLE (503), never a TypeError/500', async () => {
    // The REAL client (no throwOnError) RESOLVES with `{ error, response: undefined }` on
    // a fired AbortSignal.timeout — it does NOT reject. This is the exact deploy-blocking
    // bug the audit found: the catch in submitWorkflow never fires on this path, so the
    // `!result.data` block runs with `response === undefined`. The `!response` guard must
    // map it to 503 BEFORE the `response.status` switch (which would crash on
    // `undefined.status` → a raw TypeError/500 — worsening the very metric this PR targets).
    mockSubmitWorkflow.mockResolvedValue(timeoutResolveResult());

    const err = await runWithFakeTimers(() =>
      submitWorkflow({
        token: 'tok',
        body: {} as any,
        query: { whatif: true } as any,
      }).catch((e) => e)
    );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
    // CRITICAL regression guard: the abort path must NOT crash on `undefined.status`.
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toMatch(/Cannot read properties of undefined/i);
    // Retry preserved on whatIf — all 3 attempts ran before the final 503.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
    // Each whatIf attempt is bounded by a fresh per-attempt signal.
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('also maps a GENUINELY THROWN network error (belt-and-suspenders catch / future throwOnError) to 503', async () => {
    // If the client is ever configured with throwOnError, or a non-fetch network error
    // truly throws, the try/catch around submitWorkflowWithRetry must still map it to 503.
    // Keep this case so the fix is robust to BOTH client behaviors (resolve AND throw).
    mockSubmitWorkflow.mockRejectedValue(timeoutError());

    const err = await runWithFakeTimers(() =>
      submitWorkflow({
        token: 'tok',
        body: {} as any,
        query: { whatif: true } as any,
      }).catch((e) => e)
    );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
  });

  it('passes a per-attempt signal ONLY for whatIf, never for generate', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    // whatIf → bounded
    await submitWorkflow({ token: 'tok', body: {} as any, query: { whatif: true } as any });
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

    mockSubmitWorkflow.mockClear();

    // generate (no whatif) → NO signal, behavior unchanged
    await submitWorkflow({ token: 'tok', body: {} as any, query: {} as any });
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeUndefined();
  });

  it('generate path: a final network throw propagates raw (→500), NOT remapped to 503 by the timeout branch', async () => {
    // A code-bug-style throw (not a recognized network error) must bubble unchanged on
    // the generate path so real bugs stay visible.
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    mockSubmitWorkflow.mockRejectedValue(bug);

    const err = await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e)
    );

    expect(err).toBe(bug);
    expect(err).not.toBeInstanceOf(TRPCError);
    // Generate keeps the default 3 retries.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
  });
});
