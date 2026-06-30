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

// A TimeoutError as thrown by a fired AbortSignal.timeout() (a DOMException named
// 'TimeoutError'). isUpstreamNetworkError matches `.name === 'TimeoutError'`.
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

const okResult = (id = 'wf-1') => ({ data: { id }, response: { status: 200 } });

describe('submitWorkflowWithRetry — per-attempt timeout', () => {
  it('fires the per-attempt timeout on a hanging attempt, retries with a FRESH deadline, and honors maxAttempts', async () => {
    // Every attempt "times out" (the per-attempt AbortSignal fires). The wrapper must
    // treat each as a transient throw → backoff → retry, so all maxAttempts run. A hang
    // on attempt 1 must NOT consume attempt 2's budget (each gets a fresh signal).
    mockSubmitWorkflow.mockRejectedValue(timeoutError());

    const err = await submitWorkflowWithRetry(
      { client: {} as any, body: {} as any, query: { whatif: true } as any },
      { maxAttempts: 3, baseDelayMs: 1, perAttemptTimeoutMs: 8_000 }
    ).catch((e) => e);

    // Final attempt's throw propagates out of the wrapper (classified by the caller).
    expect((err as Error).name).toBe('TimeoutError');
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
      .mockRejectedValueOnce(timeoutError())
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

  it('maps an exhausted whatIf per-attempt timeout to SERVICE_UNAVAILABLE (503), not 500', async () => {
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
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
    // Retry preserved on whatIf — all 3 attempts ran before the final 503.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
    // Each whatIf attempt is bounded by a fresh per-attempt signal.
    expect(mockSubmitWorkflow.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
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
