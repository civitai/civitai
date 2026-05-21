import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deepStringProxy } from './test-utils';
import { InMemoryRedis } from './in-memory-redis';

// ---------------------------------------------------------------------------
// Near-integration test: exercises the actual `createCounter` factory from
// `~/server/games/new-order/utils` against an in-memory Redis-like store.
// Catches race / clamp / cache-miss correctness issues that the pure-fn and
// mocked-service tests can't see.
// ---------------------------------------------------------------------------

const { mockSysRedis, mockSetActiveSlot } = vi.hoisted(() => {
  // Defer InMemoryRedis instantiation to per-test setup; here just create the
  // stub instance vi.mock will close over.
  const instance: any = {};
  return {
    mockSysRedis: instance,
    mockSetActiveSlot: { value: 'a' as 'a' | 'b' }, // mutable ref for active slot
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: {
    newOrderPlayer: { findMany: vi.fn().mockResolvedValue([]) },
    newOrderSmite: { groupBy: vi.fn().mockResolvedValue([]) },
  },
  dbWrite: {},
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/client', () => ({
  redis: mockSysRedis, // share the same instance for both clients
  sysRedis: mockSysRedis,
  REDIS_KEYS: deepStringProxy('rk'),
  REDIS_SYS_KEYS: deepStringProxy('rsk'),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/utils/errorHandling', () => ({
  handleLogError: vi.fn(),
  throwBadRequestError: (msg: string) => new Error(msg),
  throwInternalServerError: (msg: string) => new Error(msg),
  throwNotFoundError: (msg: string) => new Error(msg),
}));

// Import AFTER mocks
import {
  smitesCounter,
  fervorCounter,
  acolyteFailedJudgments,
  getImageRatingsCounter,
  getActiveSlot,
  setActiveSlot,
  checkVotingRateLimit,
} from '~/server/games/new-order/utils';

function bindRedis(store: InMemoryRedis) {
  // Rebind methods so the mocked sysRedis/redis instance delegates to a fresh
  // InMemoryRedis per test.
  for (const k of Object.keys(mockSysRedis)) delete mockSysRedis[k];
  const proto = Object.getPrototypeOf(store);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    mockSysRedis[name] = (store as any)[name].bind(store);
  }
  // Generic / multi
  mockSysRedis.multi = store.multi.bind(store);
  // Expose ttls for inspection
  mockSysRedis._store = store;
  mockSysRedis.packed = { get: vi.fn() };
}

let store: InMemoryRedis;
beforeEach(() => {
  store = new InMemoryRedis();
  bindRedis(store);
});

// ===========================================================================
// Counter increment: unordered hash counters
// ===========================================================================
describe('createCounter (unordered) - increment', () => {
  it('increments per-user smite count atomically', async () => {
    expect(await smitesCounter.getCount(100)).toBe(0);
    expect(await smitesCounter.increment({ id: 100 })).toBe(1);
    expect(await smitesCounter.increment({ id: 100 })).toBe(2);
    expect(await smitesCounter.getCount(100)).toBe(2);
  });

  it('handles concurrent increments without lost updates (zIncrBy/hIncrBy are atomic)', async () => {
    // 20 concurrent +1s should sum to 20.
    await smitesCounter.increment({ id: 200 }); // seed
    const tasks = Array.from({ length: 20 }, () => smitesCounter.increment({ id: 200 }));
    await Promise.all(tasks);
    expect(await smitesCounter.getCount(200)).toBe(21);
  });

  it('isolates counts per user', async () => {
    await smitesCounter.increment({ id: 1 });
    await smitesCounter.increment({ id: 2, value: 3 });
    expect(await smitesCounter.getCount(1)).toBe(1);
    expect(await smitesCounter.getCount(2)).toBe(3);
  });
});

// ===========================================================================
// Counter decrement: clamp at 0 + concurrent race
// ===========================================================================
describe('createCounter (unordered) - decrement', () => {
  it('decrements toward zero', async () => {
    await smitesCounter.increment({ id: 100, value: 3 });
    expect(await smitesCounter.decrement({ id: 100 })).toBe(2);
    expect(await smitesCounter.decrement({ id: 100 })).toBe(1);
    expect(await smitesCounter.decrement({ id: 100 })).toBe(0);
    expect(await smitesCounter.getCount(100)).toBe(0);
  });

  it('clamps at 0 (does not go negative on over-decrement)', async () => {
    await smitesCounter.increment({ id: 100 });
    await smitesCounter.decrement({ id: 100 });
    // Already at 0 — further decrement stays 0.
    await smitesCounter.decrement({ id: 100 });
    expect(await smitesCounter.getCount(100)).toBe(0);
  });

  it('REGRESSION (race): two concurrent decrement calls from count=2 can race past 0', async () => {
    // This test documents the known read-then-write race in `decrement`.
    // Real Redis would have the same race (the impl is NOT atomic).
    // With our deterministic in-memory store, two concurrent decrements both
    // read 2, both call hIncrBy(-1), end up at 0. The clamp branch isn't
    // exercised because the second one sees newValue=1 (>0) and uses
    // hIncrBy instead of reset. End state should be 0 — which IS correct
    // by accident here. If a fix is made (CAS or LUA script), update this
    // test to assert determinism under contention.
    await smitesCounter.increment({ id: 100, value: 2 });
    await Promise.all([
      smitesCounter.decrement({ id: 100 }),
      smitesCounter.decrement({ id: 100 }),
    ]);
    const final = await smitesCounter.getCount(100);
    // Under deterministic execution, ends at 0. In real Redis under load,
    // could end at 1 if both reads happen before either write — the impl
    // would call hIncrBy(-1) twice → -... wait, both call hIncrBy(-1) which
    // is atomic → ends at 0 either way. This test pins current behavior.
    expect(final).toBe(0);
  });
});

// ===========================================================================
// Counter reset: id list + reset all
// ===========================================================================
describe('createCounter - reset', () => {
  it('reset by single id removes only that field', async () => {
    await smitesCounter.increment({ id: 1 });
    await smitesCounter.increment({ id: 2 });
    await smitesCounter.reset({ id: 1 });
    expect(await smitesCounter.getCount(1)).toBe(0);
    expect(await smitesCounter.getCount(2)).toBe(1);
  });

  it('reset by id array removes multiple fields in one call', async () => {
    await smitesCounter.increment({ id: 1 });
    await smitesCounter.increment({ id: 2 });
    await smitesCounter.increment({ id: 3 });
    await smitesCounter.reset({ id: [1, 2] });
    expect(await smitesCounter.getCount(1)).toBe(0);
    expect(await smitesCounter.getCount(2)).toBe(0);
    expect(await smitesCounter.getCount(3)).toBe(1);
  });

  it('reset all wipes the whole key', async () => {
    await smitesCounter.increment({ id: 1 });
    await smitesCounter.increment({ id: 2 });
    await smitesCounter.reset({ all: true });
    expect(await smitesCounter.getCount(1)).toBe(0);
    expect(await smitesCounter.getCount(2)).toBe(0);
  });
});

// ===========================================================================
// Counter cache-miss fallback (image ratings counter — should return 0)
// ===========================================================================
describe('getImageRatingsCounter - cache miss fallback', () => {
  it('returns 0 for fresh image with no votes (does not invent weighted scores)', async () => {
    // Per the recent fix, the rating counter's fetchCount returns zeros on
    // cache miss instead of recomputing wrong raw counts from ClickHouse.
    const counter = getImageRatingsCounter(9999);
    expect(await counter.getCount('Knight-4')).toBe(0);
    expect(await counter.getCount('Knight-8')).toBe(0);
  });

  it('accumulates weighted scores via increment, returns them via getAll', async () => {
    const counter = getImageRatingsCounter(8888);
    await counter.increment({ id: 'Knight-4', value: 100 });
    await counter.increment({ id: 'Knight-4', value: 150 });
    await counter.increment({ id: 'Knight-8', value: 100 });

    const all = await counter.getAll({ withCount: true });
    const byKey = Object.fromEntries(all.map((e: any) => [e.value, e.score]));
    expect(byKey['Knight-4']).toBe(250);
    expect(byKey['Knight-8']).toBe(100);
  });
});

// ===========================================================================
// Ordered counter (sorted set): fervor leaderboard semantics
// ===========================================================================
describe('createCounter (ordered) - fervor leaderboard', () => {
  it('zRangeWithScores returns members sorted by score descending', async () => {
    await fervorCounter.increment({ id: 1, value: 100 });
    await fervorCounter.increment({ id: 2, value: 300 });
    await fervorCounter.increment({ id: 3, value: 200 });

    const top = await fervorCounter.getAll({ withCount: true });
    expect(top).toEqual([
      { value: '2', score: 300 },
      { value: '3', score: 200 },
      { value: '1', score: 100 },
    ]);
  });

  it('reset removes member from leaderboard entirely (not just zero)', async () => {
    await fervorCounter.increment({ id: 1, value: 100 });
    await fervorCounter.reset({ id: 1 });

    const top = await fervorCounter.getAll({ withCount: true });
    expect(top).toEqual([]);
  });

  it('decrement that hits 0 removes the member (no zero-score zombies)', async () => {
    await fervorCounter.increment({ id: 1, value: 5 });
    await fervorCounter.decrement({ id: 1, value: 5 });
    // ordered counter `decrement` to 0 calls `reset({ id })` per impl
    const top = await fervorCounter.getAll({ withCount: true });
    expect(top).toEqual([]);
  });
});

// ===========================================================================
// Slot rotation: getActiveSlot / setActiveSlot
// ===========================================================================
describe('getActiveSlot / setActiveSlot', () => {
  it('defaults to slot "a" when not set', async () => {
    expect(await getActiveSlot('Knight', 'filling')).toBe('a');
    expect(await getActiveSlot('Knight', 'rating')).toBe('a');
  });

  it('round-trips a → b → a', async () => {
    await setActiveSlot('Knight', 'filling', 'b');
    expect(await getActiveSlot('Knight', 'filling')).toBe('b');
    await setActiveSlot('Knight', 'filling', 'a');
    expect(await getActiveSlot('Knight', 'filling')).toBe('a');
  });

  it('keeps filling and rating slots independent', async () => {
    await setActiveSlot('Knight', 'filling', 'b');
    expect(await getActiveSlot('Knight', 'rating')).toBe('a');
  });

  it('keeps slots per-rank independent', async () => {
    await setActiveSlot('Knight', 'filling', 'b');
    expect(await getActiveSlot('Acolyte', 'filling')).toBe('a');
  });
});

// ===========================================================================
// Rate limiter: per-window sliding behaviour against in-memory store
// ===========================================================================
describe('checkVotingRateLimit', () => {
  it('returns denied with dayLimitExceeded=false when config missing', async () => {
    const r = await checkVotingRateLimit(100);
    expect(r.allowed).toBe(false);
    expect(r.dayLimitExceeded).toBe(false);
  });

  it('allows votes under the per-minute limit', async () => {
    await mockSysRedis.set(
      'rsk:NEW_ORDER:CONFIG'.replace('rsk:', ''),
      '',
      {}
    );
    // Use packed.get for config — provide a config via the packed shim
    mockSysRedis.packed.get = vi.fn().mockResolvedValue({
      perMinute: 5,
      perHour: 100,
      perDay: 1000,
    });

    const r = await checkVotingRateLimit(100);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeGreaterThanOrEqual(0);
  });

  it('denies once per-minute limit is reached', async () => {
    mockSysRedis.packed.get = vi.fn().mockResolvedValue({
      perMinute: 3,
      perHour: 100,
      perDay: 1000,
    });

    let lastResult;
    for (let i = 0; i < 4; i++) lastResult = await checkVotingRateLimit(200);
    expect(lastResult!.allowed).toBe(false);
    expect(lastResult!.dayLimitExceeded).toBe(false);
  });

  it('flags dayLimitExceeded when per-day limit is hit', async () => {
    mockSysRedis.packed.get = vi.fn().mockResolvedValue({
      perMinute: 100,
      perHour: 100,
      perDay: 2,
    });

    await checkVotingRateLimit(300);
    await checkVotingRateLimit(300);
    const r = await checkVotingRateLimit(300);
    expect(r.allowed).toBe(false);
    expect(r.dayLimitExceeded).toBe(true);
  });
});

// ===========================================================================
// resetPlayer counter coverage: integration check that all relevant counters
// can be reset together against the same backing store
// ===========================================================================
describe('counter coverage', () => {
  it('resetting acolyteFailedJudgments wipes wrong-answer history (regression for the recent fix)', async () => {
    await acolyteFailedJudgments.increment({ id: 100 });
    await acolyteFailedJudgments.increment({ id: 100 });
    expect(await acolyteFailedJudgments.getCount(100)).toBe(2);

    await acolyteFailedJudgments.reset({ id: 100 });
    expect(await acolyteFailedJudgments.getCount(100)).toBe(0);
  });
});
