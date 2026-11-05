import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/env/server', () => ({
  env: { ORCHESTRATOR_ENDPOINT: 'https://orchestrator.test', ORCHESTRATOR_ACCESS_TOKEN: 'svc' },
}));

const { cancelPendingWorkflows, CANCEL_PENDING_DEADLINE_MS } = await import(
  '~/server/services/orchestrator/cancel-pending-workflows'
);

const fetchMock = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 })
);
const failures = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as { name: string; userId?: number })
    .filter((entry) => entry.name === 'mute.cancel-workflows-failed');

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cancelPendingWorkflows', () => {
  it("asks the orchestrator to cancel all of the account's unfinished workflows", async () => {
    await cancelPendingWorkflows(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://orchestrator.test/v1/manager/users/42/workflows');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual([
      { op: 'replace', path: '/status', value: 'canceled' },
    ]);
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer svc',
      'Content-Type': 'application/json-patch+json',
    });
    expect(failures()).toEqual([]);
  });

  it('retries once, then logs the account', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(cancelPendingWorkflows(42)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failures().map((f) => f.userId)).toEqual([42]);
  });

  it('succeeds on the retry without logging a failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    await cancelPendingWorkflows(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failures()).toEqual([]);
  });

  // The request is not aborted at the caller's deadline: an abort stops the orchestrator part-way
  // through the account's workflows. Do not tie the request's signal to this deadline.
  it('returns after the deadline when the orchestrator is slow, leaving the request running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    // Faked timers do not drive `AbortSignal.timeout`, so its length is checked directly.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    });
    let settled = false;
    const done = cancelPendingWorkflows(42).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CANCEL_PENDING_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await done;
    expect(signal?.aborted).toBe(false);
    expect(timeoutSpy.mock.calls[0]?.[0]).toBeGreaterThan(CANCEL_PENDING_DEADLINE_MS);
  });
});
