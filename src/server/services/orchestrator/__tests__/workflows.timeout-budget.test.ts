import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock ONLY the generated client + the orchestrator client factory + env so we can
// drive `queryWorkflows` / `submitWorkflow` through their timeout-budget branches.
// The real `~/server/utils/errorHandling` loads so the actual `isUpstreamNetworkError`
// classification + TRPCError mapping is exercised. We do NOT rely on real timers /
// a real AbortSignal.timeout firing — we simulate the fired-budget outcome by making
// the mocked client throw a `TimeoutError` (exactly what AbortSignal.timeout produces),
// keeping the tests deterministic.
const { mockQueryWorkflows, mockSubmitWorkflow } = vi.hoisted(() => ({
  mockQueryWorkflows: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  queryWorkflows: mockQueryWorkflows,
  submitWorkflow: mockSubmitWorkflow,
  // unused-by-these-tests named exports referenced at module load
  getWorkflow: vi.fn(),
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn(() => 'handled error'),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';

const baseQueryArgs = {
  token: 'tok',
  hideMatureContent: false,
} as any;

// A fired AbortSignal.timeout(ms) rejects the fetch with a `TimeoutError`. We
// reproduce that exact shape so the real `isUpstreamNetworkError` (which matches
// `name === 'TimeoutError'`) classifies it without depending on real timers.
const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queryWorkflows timeout budget', () => {
  it('maps a fired-budget TimeoutError to SERVICE_UNAVAILABLE (503)', async () => {
    mockQueryWorkflows.mockRejectedValue(timeoutError());
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('passes an AbortSignal into the client query call (the budget is armed)', async () => {
    mockQueryWorkflows.mockResolvedValue({ data: { items: [], next: undefined } });
    await queryWorkflows(baseQueryArgs);
    expect(mockQueryWorkflows).toHaveBeenCalledTimes(1);
    const callArg = mockQueryWorkflows.mock.calls[0][0];
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('submitWorkflow timeout budget (whatIf path)', () => {
  it('WITH timeoutMs: every attempt TimeoutError → SERVICE_UNAVAILABLE (503)', async () => {
    // submitWorkflowWithRetry re-throws the network error once retries are
    // exhausted; the new wrapper maps it to a retry-able 503.
    mockSubmitWorkflow.mockRejectedValue(timeoutError());
    const err = await submitWorkflow({
      token: 'tok',
      body: { steps: [] },
      query: { whatif: true },
      timeoutMs: 25_000,
    } as any).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('WITH timeoutMs: arms the budget by threading an AbortSignal into the client call', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: { id: 'wf-1' },
      response: { status: 200 },
    });
    await submitWorkflow({
      token: 'tok',
      body: { steps: [] },
      query: { whatif: true },
      timeoutMs: 25_000,
    } as any);
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    const callArg = mockSubmitWorkflow.mock.calls[0][0];
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });

  it('WITHOUT timeoutMs (write-path guard): a TimeoutError PROPAGATES unchanged (not remapped to 503)', async () => {
    // This is the critical guard: the generate/write path must be byte-for-byte
    // unchanged. No signal, no new error mapping — the original error bubbles.
    const original = timeoutError();
    mockSubmitWorkflow.mockRejectedValue(original);
    const err = await submitWorkflow({
      token: 'tok',
      body: { steps: [] },
    } as any).catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(TRPCError);
  });

  it('WITHOUT timeoutMs: no AbortSignal is threaded into the client call', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: { id: 'wf-1' },
      response: { status: 200 },
    });
    await submitWorkflow({
      token: 'tok',
      body: { steps: [] },
    } as any);
    const callArg = mockSubmitWorkflow.mock.calls[0][0];
    expect(callArg.signal).toBeUndefined();
  });

  it('WITH timeoutMs: a non-network throw still re-throws unchanged (real bugs stay visible)', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    mockSubmitWorkflow.mockRejectedValue(bug);
    const err = await submitWorkflow({
      token: 'tok',
      body: { steps: [] },
      query: { whatif: true },
      timeoutMs: 25_000,
    } as any).catch((e) => e);
    expect(err).toBe(bug);
    expect(err).not.toBeInstanceOf(TRPCError);
  });
});
