import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `Tracker.send`'s two delivery modes.
 *
 * The retry loop had no test at all, which mattered once something started
 * deciding durability on its answer: reverting the raise to a `return` deletes
 * the whole guarantee — every failure reports success and the caller writes down
 * that a counter moved — and nothing else in the suite notices.
 */

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(async () => false),
  FLIPT_FEATURE_FLAGS: {},
}));

import { Tracker } from '../client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const metric = () => ({
  entityType: 'Image' as const,
  entityId: 1,
  metricType: 'Buzz' as const,
  metricValue: 100,
});

/**
 * The parameters are declared on the mock's type rather than left to inference: a
 * bare `vi.fn(async () => …)` is a zero-arg signature, which makes `mock.calls` the
 * empty tuple and every `calls[0][1]` below unreadable.
 */
type FetchStub = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const respond = (status: number) =>
  vi.fn<FetchStub>(async () => ({ ok: status < 400, status, text: async () => '' }));

let fetchMock: ReturnType<typeof respond>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = respond(200);
  vi.stubGlobal('fetch', fetchMock);
});

describe('awaitDelivery', () => {
  it('raises when the retries are exhausted, so the caller does not record a lost event', async () => {
    fetchMock = respond(500);
    vi.stubGlobal('fetch', fetchMock);

    await expect(new Tracker().entityMetric(metric(), { awaitDelivery: true })).rejects.toThrow(
      /500/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports delivered on a 2xx', async () => {
    await expect(new Tracker().entityMetric(metric(), { awaitDelivery: true })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx — the payload is wrong and will stay wrong', async () => {
    fetchMock = respond(400);
    vi.stubGlobal('fetch', fetchMock);

    await expect(new Tracker().entityMetric(metric(), { awaitDelivery: true })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives each attempt its own budget, not one budget for the whole retry loop', async () => {
    fetchMock = respond(500);
    vi.stubGlobal('fetch', fetchMock);

    await expect(new Tracker().entityMetric(metric(), { awaitDelivery: true })).rejects.toThrow();

    // Nothing configures an undici dispatcher, so an unsignalled fetch inherits
    // a 300s header timeout — three of those on one row is a wedge, not a retry.
    const signals = fetchMock.mock.calls.map((call) => call[1]?.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    // One signal hoisted out of the loop would be worse than none: `fetch`
    // rejects immediately on an already-aborted signal, so the first slow
    // attempt would silently consume the other two.
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]).not.toBe(signals[2]);
  });
});

describe('fire and forget', () => {
  it('leaves the request unsignalled — nobody is holding a response open for it', async () => {
    await new Tracker().entityMetric(metric());
    // The dispatch is not awaited, so let its first attempt reach fetch.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, init] = fetchMock.mock.calls[0];
    // Asserted present first: `init?.signal` on a missing init is also undefined,
    // and would pass this without the request ever having been made.
    expect(init).toBeDefined();
    expect(init?.signal).toBeUndefined();
  });

  // LAST on purpose. Its retry chain outlives the test by ~750ms and `fetch` is
  // resolved from the global at call time, so a later test's stub would receive
  // this one's third attempt.
  it('swallows an exhausted failure, because nothing is waiting on it', async () => {
    fetchMock = respond(500);
    vi.stubGlobal('fetch', fetchMock);

    await expect(new Tracker().entityMetric(metric())).resolves.toBe(true);
  });
});
