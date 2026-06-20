import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Mock ONLY the generated client + the orchestrator client factory + env so we can
// drive `getWorkflow` / `queryWorkflows` through their error branches. The real
// `~/server/utils/errorHandling` loads so the actual TRPCError mapping is exercised.
const { mockGetWorkflow, mockQueryWorkflows } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockQueryWorkflows: vi.fn(),
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

  it('does NOT 503 a genuine code-bug throw', async () => {
    const bug = new TypeError('boom is not a function');
    mockQueryWorkflows.mockRejectedValue(bug);
    const err = await queryWorkflows(baseQueryArgs).catch((e) => e);
    expect(err).toBe(bug);
  });
});
