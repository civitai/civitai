import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * The REAL `submitWorkflow` retry loop, with only the generated `@civitai/client`
 * transport mocked: which attempt received a status-bearing failure, recorded on the
 * thrown error, and the training submit's classification of it.
 *
 * The case that matters: attempt 1 fails in a way that may have created and charged
 * the workflow (a 5xx), and attempt 2 then gets a 4xx. That 4xx is not a refusal.
 */

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
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

import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import {
  annotateOrchestratorSubmitFailure,
  getOrchestratorSubmitFailure,
  isDefiniteOrchestratorSubmitRefusal,
} from '~/server/services/orchestrator/submit-failure';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

const errorResolve = (status: number) => ({
  data: undefined,
  error: { status, detail: `upstream ${status}` },
  response: { status },
});

async function submitAndCatch() {
  vi.useFakeTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e);
  await vi.runAllTimersAsync();
  return p;
}

describe('submitWorkflow — the failing attempt is recorded on the thrown error', () => {
  it('a 4xx on the FIRST attempt: attempt 1, no retry, a definite refusal', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(400));
    const err = await submitAndCatch();
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
    expect(getOrchestratorSubmitFailure(err)).toEqual({ attempt: 1, status: 400 });
    expect(isDefiniteOrchestratorSubmitRefusal(err)).toBe(true);
  });

  it.each([400, 409, 429])(
    'a 5xx then a %i: attempt 2, NOT a definite refusal (attempt 1 may have charged)',
    async (status) => {
      mockSubmitWorkflow
        .mockResolvedValueOnce(errorResolve(503))
        .mockResolvedValueOnce(errorResolve(status));
      const err = await submitAndCatch();
      expect(err).toBeInstanceOf(TRPCError);
      expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
      expect(getOrchestratorSubmitFailure(err)).toEqual({ attempt: 2, status });
      expect(isDefiniteOrchestratorSubmitRefusal(err)).toBe(false);
    }
  );

  it('a 409 on the first attempt (an existing workflow for the id) is not a refusal', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(409));
    const err = await submitAndCatch();
    expect(getOrchestratorSubmitFailure(err)).toEqual({ attempt: 1, status: 409 });
    expect(isDefiniteOrchestratorSubmitRefusal(err)).toBe(false);
  });

  it('a network failure after the last retry carries no record and is not a refusal', async () => {
    mockSubmitWorkflow.mockRejectedValue(new TypeError('fetch failed'));
    const err = await submitAndCatch();
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(getOrchestratorSubmitFailure(err)).toBeUndefined();
    expect(isDefiniteOrchestratorSubmitRefusal(err)).toBe(false);
  });

  it('other callers see an unchanged error: same code, message, cause, keys and JSON', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(429));
    const err = (await submitAndCatch()) as TRPCError;
    expect(getOrchestratorSubmitFailure(err)).toEqual({ attempt: 1, status: 429 });
    // The record is a non-enumerable symbol: invisible to keys, spread and JSON.
    const plain = new TRPCError({ code: err.code, message: err.message, cause: err.cause });
    expect(Object.keys(err)).toEqual(Object.keys(plain));
    expect(JSON.stringify(err)).toBe(JSON.stringify(plain));
    expect({ ...err }).toEqual({ ...plain });
    expect(err.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('isDefiniteOrchestratorSubmitRefusal — the classification itself', () => {
  const recorded = (attempt: number, status: number) => {
    const e = new TRPCError({ code: 'BAD_REQUEST', message: 'x' });
    annotateOrchestratorSubmitFailure(e, { attempt, status });
    return e;
  };

  it.each([
    [1, 400, true],
    [1, 499, true],
    [1, 409, false],
    [1, 500, false],
    [1, 399, false],
    [2, 400, false],
    [3, 429, false],
  ])('attempt %i, status %i → %s', (attempt, status, expected) => {
    expect(isDefiniteOrchestratorSubmitRefusal(recorded(attempt, status))).toBe(expected);
  });

  it('an error with no record is not a refusal, whatever its code', () => {
    expect(
      isDefiniteOrchestratorSubmitRefusal(new TRPCError({ code: 'BAD_REQUEST', message: 'x' }))
    ).toBe(false);
    expect(isDefiniteOrchestratorSubmitRefusal(undefined)).toBe(false);
  });
});
