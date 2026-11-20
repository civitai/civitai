import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

// Which ClickHouse the image MetricService reads: the dedicated entity-metrics client only when it
// is configured AND `image-metrics-dedicated-clickhouse` is on; the shared one otherwise. Runs the
// REAL MetricService against two fake ClickHouse clients that answer different counts, so the
// served number says which client was read, and only process boundaries are mocked.
//
// The three "reads the shared client" cases are INVARIANT guards: they pass on the code before the
// dedicated client existed too, and pin that adding it changed nothing while it is not selected.

vi.hoisted(() => {
  // The event-engine logger is on at DEBUG under NODE_ENV=test and reads its level once, at import.
  process.env.EVENT_ENGINE_LOG_LEVEL = 'ERROR';
});

const { shared, dedicated, state, isFliptSyncMock } = vi.hoisted(() => {
  // Answers every populate query with `like` reactions for each id it names.
  const fakeClickhouse = (like: number) => {
    const query = vi.fn(async ({ query }: { query: string }) => {
      const ids = (/entityId IN \(([^)]*)\)/.exec(query)?.[1] ?? '').split(',').map(Number);
      return {
        json: async () => ids.map((id) => ({ entityId: id, metricType: 'Like', value: like })),
      };
    });
    return { client: { query }, query };
  };
  return {
    // Distinct, and neither is a count a default or an empty read could produce.
    shared: fakeClickhouse(11),
    dedicated: fakeClickhouse(29),
    state: { dedicatedConfigured: true, flags: {} as Record<string, boolean | null> },
    isFliptSyncMock: vi.fn(),
  };
});

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: shared.client }));
vi.mock('~/server/clickhouse/metrics-client', () => ({
  get clickhouseMetrics() {
    return state.dedicatedConfigured ? dedicated.client : undefined;
  },
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: isFliptSyncMock,
  // An initialised client, so a null read does not try to start one.
  getFliptClientSync: () => ({}),
}));

import { getImageMetricsObjectDirect } from '../image.service';
import { resetImageMetricsClickhouseGateForTests } from '../image-metrics-clickhouse';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const FLAG = 'image-metrics-dedicated-clickhouse';
const GATE_WINDOW_MS = 5_000;

const readLike = async (id: number) =>
  (await getImageMetricsObjectDirect([{ id }], 2_000))[id]?.reactionLike;

describe('image MetricService ClickHouse selection', () => {
  let now = 1_800_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    // Only Date is faked: MetricService's lock heartbeat and the read deadline use real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    // After faking Date, so the gate's clock is the fake one.
    resetImageMetricsClickhouseGateForTests();
    state.dedicatedConfigured = true;
    state.flags = {};
    isFliptSyncMock.mockImplementation((key: string) => state.flags[key] ?? null);
    // Every read is a cold miss whose populate lock is won, so each one queries ClickHouse.
    redisMock.redis.hGetAll.mockResolvedValue({});
    redisMock.redis.get.mockResolvedValue(null);
    redisMock.redis.eval.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    now += 60_000;
  });

  it('flag OFF: reads the shared client, never the dedicated one', async () => {
    state.flags[FLAG] = false;

    expect(await readLike(101)).toBe(11);
    expect(shared.query).toHaveBeenCalledTimes(1);
    expect(dedicated.query).not.toHaveBeenCalled();
  });

  it('flag unknown to Flipt: reads the shared client', async () => {
    expect(await readLike(102)).toBe(11);
    expect(dedicated.query).not.toHaveBeenCalled();
  });

  it('flag ON with the dedicated client configured: reads the dedicated client only', async () => {
    state.flags[FLAG] = true;

    expect(await readLike(103)).toBe(29);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    expect(shared.query).not.toHaveBeenCalled();
    expect(isFliptSyncMock).toHaveBeenCalledWith(FLAG);
  });

  it('flag ON without the dedicated env: reads the shared client', async () => {
    state.dedicatedConfigured = false;
    state.flags[FLAG] = true;

    expect(await readLike(104)).toBe(11);
    expect(shared.query).toHaveBeenCalledTimes(1);
    expect(dedicated.query).not.toHaveBeenCalled();
  });

  it('a runtime flip takes effect once the gate window passes, both ways, without a restart', async () => {
    state.flags[FLAG] = false;
    expect(await readLike(105)).toBe(11);

    // Inside the window the cached OFF read still holds.
    state.flags[FLAG] = true;
    vi.setSystemTime(now + GATE_WINDOW_MS - 1);
    expect(await readLike(106)).toBe(11);

    vi.setSystemTime(now + GATE_WINDOW_MS + 1);
    expect(await readLike(107)).toBe(29);

    state.flags[FLAG] = false;
    vi.setSystemTime(now + 2 * GATE_WINDOW_MS + 2);
    expect(await readLike(108)).toBe(11);

    expect(shared.query).toHaveBeenCalledTimes(3);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
  });

  it('a failed dedicated read is served from the cache, and is not retried on the shared client', async () => {
    state.flags[FLAG] = true;
    dedicated.query.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    // The first hGetAll is MetricService's own miss; the next is the fallback's cache read.
    redisMock.redis.hGetAll.mockResolvedValueOnce({}).mockResolvedValue({ Like: '7' });

    expect(await readLike(109)).toBe(7);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    expect(shared.query).not.toHaveBeenCalled();
  });
});
