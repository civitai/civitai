import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Submit-path error mapping for orchestrator.whatIfFromGraph / generateFromGraph.
 *
 * These drive the REAL `submitWorkflow` (workflows.ts) through its
 * `if (!result.data)` → `switch (response.status)` branches, mocking ONLY the
 * generated `@civitai/client` + the client factory + env so the real
 * `~/server/utils/errorHandling` TRPCError mapping runs end-to-end.
 *
 * The bug this covers (bursty causeless generic 500s on whatIf/generate):
 *  - Item C: the submit switch had NO 503 branch — an upstream HTTP 5xx (or an
 *    HTML gateway/LB error page, a 5xx body starting with `<!DOCTYPE`) surfaced as
 *    a generic INTERNAL_SERVER_ERROR (500), unlike the READ paths (getWorkflow /
 *    queryWorkflows) which map upstream 5xx → retry-able 503 via
 *    `isUpstreamServerOrNetworkError`. We now mirror that mapping on submit.
 *  - Item B: those 5xx sites threw `throwInternalServerError(<string>)`, dropping
 *    the structured client error — only a STRING survived as `cause`, which the
 *    un-masking logger (`buildServerFaultErrorLog`) renders EMPTY, hiding the
 *    trigger. The original client error is now preserved as `cause`.
 */

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
  // handleError derives the fallback user-facing message from the client error.
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : 'err')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

import { submitWorkflow } from '~/server/services/orchestrator/workflows';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// Upstream 5xx responses are `retryable` in submitWorkflowWithRetry, so the wrapper
// backs off (real setTimeout) between its 3 attempts. Skip that wait deterministically
// with fake timers so the suite stays fast.
const runWithFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  const p = fn();
  await vi.runAllTimersAsync();
  return p;
};

// A resolve shape (NOT a reject): the @civitai/client with no `throwOnError` RESOLVES
// `{ data: undefined, error, response }` on an upstream error response.
const errorResolve = (status: number, error: Record<string, unknown>) => ({
  data: undefined,
  error,
  response: { status },
});

describe('submitWorkflow — upstream 5xx → retry-able 503 (Item C) + cause preserved (Item B)', () => {
  it('maps an orchestrator HTTP 500 to SERVICE_UNAVAILABLE (503), NOT a generic 500', async () => {
    const upstreamError = { status: 500, detail: 'boom' };
    mockSubmitWorkflow.mockResolvedValue(errorResolve(500, upstreamError));

    const err = await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e)
    );

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toMatch(/temporarily unavailable/i);
    // upstream 5xx is retryable → all 3 attempts ran before the final 503.
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(3);
  });

  it('preserves the ORIGINAL client error on `.cause` so the un-masking log is non-empty (Item B)', async () => {
    const upstreamError = { status: 500, detail: 'orchestrator exploded' };
    mockSubmitWorkflow.mockResolvedValue(errorResolve(500, upstreamError));

    const err = await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e)
    );

    // Before the fix `.cause` was a bare string ('err') → empty in
    // buildServerFaultErrorLog. Now it carries the structured client error.
    const cause = (err as TRPCError).cause as unknown;
    expect(cause).toBeDefined();
    expect(cause).toMatchObject({ status: 500, detail: 'orchestrator exploded' });
  });

  it('maps an upstream 503/504-class status (via `default`) to 503', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(503, { status: 503, detail: '' }));

    const err = await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as any, query: { whatif: true } as any }).catch(
        (e) => e
      )
    );

    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('maps an HTML gateway error page (5xx body starting with <!DOCTYPE) to 503', async () => {
    // A gateway/LB returns an HTML error page; the client surfaces it as the 5xx
    // response `messages`. status 502 → transient upstream → 503 (was 500 before).
    const htmlError = {
      status: 502,
      errors: { messages: ['<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'] },
    };
    mockSubmitWorkflow.mockResolvedValue(errorResolve(502, htmlError));

    const err = await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as any, query: {} as any }).catch((e) => e)
    );

    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).cause).toMatchObject({ status: 502 });
  });
});

describe('submitWorkflow — genuine app/validation faults are NOT converted to 503', () => {
  it('keeps an orchestrator 400 as BAD_REQUEST (client fault), not 503', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(400, { status: 400, detail: 'bad input' }));

    // 4xx is not retryable → returns on the first attempt (no backoff, no fake timers).
    const err = await submitWorkflow({
      token: 'tok',
      body: {} as any,
      query: {} as any,
    }).catch((e) => e);

    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('keeps an unhandled 4xx (422) as BAD_REQUEST, not 503', async () => {
    mockSubmitWorkflow.mockResolvedValue(errorResolve(422, { status: 422, detail: 'unprocessable' }));

    const err = await submitWorkflow({
      token: 'tok',
      body: {} as any,
      query: {} as any,
    }).catch((e) => e);

    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('a non-4xx/5xx anomaly with no data stays INTERNAL_SERVER_ERROR (500), cause preserved', async () => {
    // A malformed "success" (2xx status but no `data`) is NOT a recognized transient
    // upstream failure, so it must stay a visible 500 — but carry the original error
    // as `cause` (Item B), never a bare string.
    const anomaly = { status: 200, detail: 'no data' };
    mockSubmitWorkflow.mockResolvedValue(errorResolve(200, anomaly));

    const err = await submitWorkflow({
      token: 'tok',
      body: {} as any,
      query: {} as any,
    }).catch((e) => e);

    expect((err as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((err as TRPCError).cause).toMatchObject({ status: 200, detail: 'no data' });
  });

  it('returns data untouched on the success path', async () => {
    mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-1' }, response: { status: 200 } });

    const data = await submitWorkflow({ token: 'tok', body: {} as any, query: {} as any });
    expect(data).toEqual({ id: 'wf-1' });
  });
});
