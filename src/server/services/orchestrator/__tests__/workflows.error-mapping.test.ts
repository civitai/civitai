import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock ONLY the generated client + the orchestrator client factory + env so we can
// drive `getWorkflow` / `queryWorkflows` through their error branches. The real
// `~/server/utils/errorHandling` loads so the actual TRPCError mapping is exercised.
const { mockGetWorkflow, mockQueryWorkflows, mockObserveRead } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockQueryWorkflows: vi.fn(),
  mockObserveRead: vi.fn(),
}));

vi.mock('@civitai/client', () => ({
  getWorkflow: mockGetWorkflow,
  queryWorkflows: mockQueryWorkflows,
  // unused-by-these-tests named exports referenced at module load
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

// Spy the additive read metric so we can assert the outcome classification wired into workflows.ts without
// touching the real prom registry (the metric's own value-recording is covered in orchestrator-read-metrics.test.ts).
vi.mock('~/server/services/orchestrator/orchestrator-read-metrics', () => ({
  observeOrchestratorRead: mockObserveRead,
}));

import { getWorkflow, queryWorkflows } from '~/server/services/orchestrator/workflows';

const baseQueryArgs = {
  token: 'tok',
  hideMatureContent: false,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getWorkflow error mapping', () => {
  it('maps an upstream 5xx (status>=500) to SERVICE_UNAVAILABLE (503), preserving cause', async () => {
    // Repro of the real prod signature: empty-message raw error + upstream status 500.
    const upstreamError = { status: 500, detail: 'Internal Server Error' };
    mockGetWorkflow.mockResolvedValue({ data: undefined, error: upstreamError });

    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
    // tRPC v11 wraps a non-Error cause in UnknownCauseError, copying its props —
    // the original upstream error stays diagnosable (status/detail preserved).
    expect((err as TRPCError).cause).toMatchObject(upstreamError);
  });

  it('maps a status-less network rejection (fetch failed) to 503', async () => {
    mockGetWorkflow.mockRejectedValue(new TypeError('fetch failed'));

    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toBeInstanceOf(TypeError);
  });

  it('keeps a 404 mapped as NOT_FOUND (not 503)', async () => {
    mockGetWorkflow.mockResolvedValue({
      data: undefined,
      error: { status: 404, detail: 'gone' },
    });
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
  });

  it('keeps a 400 mapped as BAD_REQUEST (not 503)', async () => {
    mockGetWorkflow.mockResolvedValue({
      data: undefined,
      error: { status: 400, detail: 'bad' },
    });
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('keeps an unhandled 4xx (422) as BAD_REQUEST, not 503', async () => {
    mockGetWorkflow.mockResolvedValue({
      data: undefined,
      error: { status: 422, detail: 'unprocessable' },
    });
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('does NOT 503 a genuine code-bug throw — it surfaces as-is (→ 500)', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    mockGetWorkflow.mockRejectedValue(bug);
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect(err).toBe(bug); // re-thrown raw; tRPC will map to INTERNAL_SERVER_ERROR
    expect(err).not.toBeInstanceOf(TRPCError);
  });

  it('maps the read-backstop AbortSignal.timeout TimeoutError to 503 (statusUpdate poll)', async () => {
    // The ORCHESTRATOR_GET_TIMEOUT_MS backstop aborts a runaway single-workflow read via
    // AbortSignal.timeout(), which surfaces a DOMException named 'TimeoutError'.
    // isUpstreamNetworkError matches `.name === 'TimeoutError'` → retry-able 503, so a
    // parked getWorkflow poll can't pin an api-pool connection unbounded.
    mockGetWorkflow.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    );
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
  });

  it('maps a status-less TimeoutError RESOLVE (the real pre-response abort shape) to 503', async () => {
    // LOAD-BEARING contract: createOrchestratorClient does NOT set `throwOnError`, so on a
    // fetch abort BEFORE response headers (the common park shape) the @civitai/client
    // RESOLVES with `{ data: undefined, error: <TimeoutError>, response: undefined }` — it
    // does NOT reject. So the fired backstop lands in the `if(!data)` default branch, NOT
    // the `.catch` above (which only the mid-body-read reject path hits). Assert that real
    // runtime path maps to 503 and does NOT crash on the status-less error (undefined
    // `error.status` → default → `error.detail?.startsWith` optional-chained →
    // isUpstreamServerOrNetworkError matches `.name==='TimeoutError'`). This mirrors the
    // resolve-shape lesson baked into submitWorkflow.timeout.test.ts.
    mockGetWorkflow.mockResolvedValue({
      data: undefined,
      error: Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
      response: undefined,
    });
    const err = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
  });

  it('passes an abort signal to the client so the read is bounded', async () => {
    // Guard the wiring: the backstop only works if getWorkflow actually hands the client
    // an AbortSignal. Without it a runaway read hangs unbounded (the pre-fix behavior).
    mockGetWorkflow.mockResolvedValue({ data: { id: 'wf-1', status: 'succeeded' } });
    await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } });
    expect(mockGetWorkflow).toHaveBeenCalledTimes(1);
    const arg = mockGetWorkflow.mock.calls[0][0];
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns data on the success path untouched', async () => {
    mockGetWorkflow.mockResolvedValue({ data: { id: 'wf-1', status: 'succeeded' } });
    const data = await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } });
    expect(data).toEqual({ id: 'wf-1', status: 'succeeded' });
  });
});

describe('queryWorkflows error mapping (queryGeneratedImages path)', () => {
  it('maps an upstream 5xx to SERVICE_UNAVAILABLE (503)', async () => {
    const upstreamError = { status: 503, detail: '' };
    mockQueryWorkflows.mockResolvedValue({ data: undefined, error: upstreamError });
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toMatchObject(upstreamError);
  });

  it('maps a network rejection to 503', async () => {
    mockQueryWorkflows.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      })
    );
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('keeps a 404 as NOT_FOUND, not 503', async () => {
    mockQueryWorkflows.mockResolvedValue({
      data: undefined,
      error: { status: 404, detail: 'gone' },
    });
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
  });

  it('maps the read-backstop AbortSignal.timeout TimeoutError to 503', async () => {
    // The ORCHESTRATOR_QUERY_TIMEOUT_MS backstop aborts a runaway query via
    // AbortSignal.timeout(), which rejects with a DOMException named 'TimeoutError'.
    // isUpstreamNetworkError matches `.name === 'TimeoutError'` → retry-able 503.
    mockQueryWorkflows.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    );
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
  });

  it('does NOT 503 a genuine code-bug throw', async () => {
    const bug = new TypeError('boom is not a function');
    mockQueryWorkflows.mockRejectedValue(bug);
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect(err).toBe(bug);
  });
});

describe('read metric wiring (observeOrchestratorRead) — additive instrumentation', () => {
  it('records op=getWorkflow outcome=ok exactly once on the success path', async () => {
    mockGetWorkflow.mockResolvedValue({ data: { id: 'wf-1', status: 'succeeded' } });
    await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } });
    expect(mockObserveRead).toHaveBeenCalledTimes(1);
    const [op, outcome, seconds] = mockObserveRead.mock.calls[0];
    expect(op).toBe('getWorkflow');
    expect(outcome).toBe('ok');
    expect(typeof seconds).toBe('number');
  });

  it('records outcome=timeout on the REJECT path (mid-body abort) for getWorkflow', async () => {
    mockGetWorkflow.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    );
    await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch(() => {});
    expect(mockObserveRead).toHaveBeenCalledTimes(1);
    expect(mockObserveRead.mock.calls[0][0]).toBe('getWorkflow');
    expect(mockObserveRead.mock.calls[0][1]).toBe('timeout');
  });

  it('records outcome=timeout on the RESOLVE path (pre-response abort, { error: TimeoutError }) for getWorkflow', async () => {
    mockGetWorkflow.mockResolvedValue({
      data: undefined,
      error: Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
      response: undefined,
    });
    await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch(() => {});
    expect(mockObserveRead).toHaveBeenCalledTimes(1);
    expect(mockObserveRead.mock.calls[0][1]).toBe('timeout');
  });

  it('records outcome=error on a non-timeout upstream 5xx for getWorkflow', async () => {
    mockGetWorkflow.mockResolvedValue({ data: undefined, error: { status: 500, detail: 'boom' } });
    await getWorkflow({ token: 'tok', path: { workflowId: 'wf-1' } }).catch(() => {});
    expect(mockObserveRead).toHaveBeenCalledTimes(1);
    expect(mockObserveRead.mock.calls[0][1]).toBe('error');
  });

  it('records op=queryWorkflows outcome=timeout on the reject path', async () => {
    mockQueryWorkflows.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    );
    await queryWorkflows(baseQueryArgs).catch(() => {});
    expect(mockObserveRead).toHaveBeenCalledTimes(1);
    expect(mockObserveRead.mock.calls[0][0]).toBe('queryWorkflows');
    expect(mockObserveRead.mock.calls[0][1]).toBe('timeout');
  });
});
