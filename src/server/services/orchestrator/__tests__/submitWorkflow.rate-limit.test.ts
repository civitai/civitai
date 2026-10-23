import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// The orchestrator answers a rate limit with a 429 problem+json and, when it knows the reset,
// `Retry-After` in seconds. A generate submit must surface that as retry-later, not a failure.

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

// Hand-listed: the package's ESM build does not load under vitest (directory import).
vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  // As the real one: a problem's `detail`.
  handleError: vi.fn((e: string | { detail?: string }) => (typeof e === 'string' ? e : e.detail)),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';

const rateLimited = (detail: string | undefined, retryAfter?: string) => ({
  data: undefined,
  error: {
    type: 'https://tools.ietf.org/html/rfc6585#section-4',
    title: 'Too Many Requests',
    status: 429,
    detail,
  },
  response: new Response(null, {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  }),
});

const submit = () =>
  submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitWorkflow — orchestrator 429', () => {
  it('is TOO_MANY_REQUESTS with the orchestrator detail and when to retry, on one attempt', async () => {
    mockSubmitWorkflow.mockResolvedValue(
      rateLimited("Free tier quota for 'flux' is exhausted", '30')
    );

    const err = await submit();

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((err as TRPCError).message).toBe(
      "Free tier quota for 'flux' is exhausted. Please try again in about 30 seconds."
    );
    // No inline retry: re-submitting into a rate limit only extends it.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('without Retry-After or a detail, says so plainly and promises no time', async () => {
    mockSubmitWorkflow.mockResolvedValue(rateLimited(undefined));

    const err = await submit();

    expect((err as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((err as TRPCError).message).toBe('Too many requests right now.');
  });

  it('clamps an absurd Retry-After to an hour', async () => {
    mockSubmitWorkflow.mockResolvedValue(rateLimited('Slow down', '999999'));

    const err = await submit();

    expect((err as TRPCError).message).toBe('Slow down. Please try again in about 3600 seconds.');
  });

  it('control: a 400 keeps BAD_REQUEST and the orchestrator text unchanged', async () => {
    mockSubmitWorkflow.mockResolvedValue({
      data: undefined,
      error: { status: 400, detail: 'bad input' },
      response: new Response(null, { status: 400, headers: { 'Retry-After': '30' } }),
    });

    const err = await submit();

    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect((err as TRPCError).message).toBe('bad input');
  });
});
