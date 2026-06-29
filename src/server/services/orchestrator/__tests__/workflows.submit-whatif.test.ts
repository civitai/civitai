import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mirror the workflows.error-mapping.test.ts mocking: stub ONLY the generated
// `@civitai/client` + the orchestrator client factory + env, so the REAL
// `submitWorkflow` (and `submitWorkflowWithRetry` + the actual
// `~/server/utils/errorHandling` TRPCError mapping) are exercised. `mockSubmit`
// stands in for the client `submitWorkflow` that `submitWorkflowWithRetry` calls
// once per attempt — so its call count proves the retry behavior.
const { mockSubmit } = vi.hoisted(() => ({
  mockSubmit: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmit,
  // unused-by-these-tests named exports referenced at module load
  getWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn((e: any) => (typeof e === 'string' ? e : e?.detail ?? '')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';

const baseBody = { steps: [], tags: [] } as any;

const whatifArgs = {
  token: 'tok',
  body: baseBody,
  query: { whatif: true },
} as any;

const generateArgs = {
  token: 'tok',
  body: baseBody,
  // generate passes NO whatif marker.
  query: {},
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitWorkflow whatIf transient-failure mapping', () => {
  it('whatIf + orchestrator 5xx result (status 500) → SERVICE_UNAVAILABLE (503), not INTERNAL_SERVER_ERROR', async () => {
    mockSubmit.mockResolvedValue({
      data: undefined,
      error: { status: 500, detail: 'Internal Server Error' },
      response: { status: 500 },
    });

    const err = await submitWorkflow(whatifArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
  });

  it('whatIf + client REJECTS with a network/timeout error → SERVICE_UNAVAILABLE (503)', async () => {
    // maxAttempts=1 → the throw propagates out of submitWorkflowWithRetry; the
    // .catch in submitWorkflow classifies it as a transient reach failure.
    mockSubmit.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { name: 'AbortError' })
    );

    const err = await submitWorkflow(whatifArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('whatIf fails FAST — submitWorkflow client is invoked exactly ONCE (maxAttempts=1, no 3× retry)', async () => {
    mockSubmit.mockRejectedValue(
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    );

    await submitWorkflow(whatifArgs).catch(() => undefined);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it('whatIf + orchestrator 403 (insufficient funds) → preserves the client-fault mapping, NOT reclassified to 503', async () => {
    mockSubmit.mockResolvedValue({
      data: undefined,
      error: { status: 403, detail: 'insufficient funds' },
      response: { status: 403 },
    });

    const err = await submitWorkflow(whatifArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    // status 403 → throwInsufficientFundsError (BAD_REQUEST) in this codebase. The
    // load-bearing assertion: a client fault is NOT swallowed into a transient 503.
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect((err as TRPCError).code).not.toBe('SERVICE_UNAVAILABLE');
  });

  it('whatIf success path returns data untouched', async () => {
    mockSubmit.mockResolvedValue({ data: { id: 'wf-1', cost: { total: 42 } } });
    const data = await submitWorkflow(whatifArgs);
    expect(data).toEqual({ id: 'wf-1', cost: { total: 42 } });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('submitWorkflow generate/write path is UNCHANGED (write-path guard)', () => {
  it('generate (no query.whatif) + status 500 → INTERNAL_SERVER_ERROR (unchanged), not 503', async () => {
    mockSubmit.mockResolvedValue({
      data: undefined,
      error: { status: 500, detail: 'Internal Server Error' },
      response: { status: 500 },
    });

    const err = await submitWorkflow(generateArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((err as TRPCError).code).not.toBe('SERVICE_UNAVAILABLE');
  });

  it('generate + client network reject → propagates the RAW error (NOT a 503 TRPCError)', async () => {
    // generate uses the default maxAttempts=3, so this exercises all three real
    // backoff sleeps (~500ms + ~1500ms) before the final throw — the call is not
    // sped up here; correctness of the raw-rethrow (write-path invariant) > speed.
    const raw = Object.assign(new Error('fetch failed'), { name: 'AbortError' });
    mockSubmit.mockRejectedValue(raw);

    const err = await submitWorkflow(generateArgs).catch((e) => e);
    // submitWorkflow's .catch re-throws unchanged for isWhatif=false → the raw
    // error surfaces; tRPC would map it to INTERNAL_SERVER_ERROR.
    expect(err).toBe(raw);
    expect(err).not.toBeInstanceOf(TRPCError);
  });

  it('generate uses the DEFAULT retry count (3 attempts) on a transient failure', async () => {
    mockSubmit.mockRejectedValue(
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    );

    await submitWorkflow(generateArgs).catch(() => undefined);
    expect(mockSubmit).toHaveBeenCalledTimes(3);
  });
});
