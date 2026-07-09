import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: the HA/Sentinel sysRedis client returns BLOB_STRING replies as a
// Buffer where the legacy single-pod client returned a string. base.metrics.ts
// reads `metric:<name>` / `rank:<name>` feature flags via sysRedis.hGet and
// compared the reply with `=== 'true'`. Against a Buffer that comparison is
// always false, silently flipping every metric/rank update flag to "disabled"
// in sentinel mode (so update/refreshRank no-op when they shouldn't).
//
// This is the metric/rank analog of the queues.ts getBucketNames regression
// fixed in PR #2697. Both use the same hoisted-mock pattern to control the
// hGet return type per-test — that's the exact axis of the bug.

const { hGet, hSet, sAdd, sMembers, withSysReadDeadline, logSysRedisFailOpen } = vi.hoisted(
  () => ({
    hGet: vi.fn(),
    hSet: vi.fn(() => Promise.resolve(1)),
    sAdd: vi.fn(() => Promise.resolve(1)),
    sMembers: vi.fn(() => Promise.resolve([] as string[])),
    // STEP-3 soft-dependency: the flag reads are now wrapped in withSysReadDeadline
    // so a SLOW/half-open sysRedis rejects (deadline) instead of parking ~11min.
    // Transparent by default (returns the wrapped promise) — override per-test to reject.
    withSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    // Spy the fail-open emitter so the fail-open path stays observable in the test
    // (a blip that bypasses a kill-switch must leave a Loki `sysredis-fail-open` trace).
    logSysRedisFailOpen: vi.fn(),
  })
);

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet, hSet, sAdd, sMembers, del: vi.fn(), exists: vi.fn() },
  REDIS_SYS_KEYS: {
    SYSTEM: { FEATURES: 'system:features' },
    QUEUES: { BUCKETS: 'queues:buckets' },
  },
  REDIS_SUB_KEYS: { QUEUES: { MERGING: 'merging' } },
  withSysReadDeadline,
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

// Provide a non-null clickhouse so the early-return in update()/refreshRank()
// doesn't fire (we want execution to reach the flag-read on the sysRedis mock).
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('~/server/db/client', () => ({ dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbWrite: {} }));

// Stub getJobDate so the processor never touches a real timestamp store. Return
// a far-past date so `shouldUpdate` / `shouldUpdateRank` is true — the flag is
// the only gate left on the path under test.
const setLastUpdate = vi.fn(() => Promise.resolve(undefined));
vi.mock('~/server/jobs/job', () => ({
  getJobDate: vi.fn(async () => [new Date(0), setLastUpdate] as const),
}));

// queues is exercised transitively by update() via checkoutQueue. Stub the
// queue handle minimally — update() only awaits commit() and reads .content.
vi.mock('~/server/redis/queues', () => ({
  checkoutQueue: vi.fn(async () => ({
    content: [],
    commit: vi.fn(() => Promise.resolve(undefined)),
  })),
  addToQueue: vi.fn(() => Promise.resolve(undefined)),
}));

import { createMetricProcessor } from '~/server/metrics/base.metrics';

const jobContext = {
  on: vi.fn(),
  checkIfCanceled: vi.fn(() => Promise.resolve(false)),
  cancel: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  withSysReadDeadline.mockImplementation((p) => p); // transparent by default
});

describe('createMetricProcessor — update() metric flag (Buffer-vs-string)', () => {
  it('treats Buffer("true") as enabled and runs the update (was silently disabled pre-fix)', async () => {
    hGet.mockResolvedValue(Buffer.from('true', 'utf8'));
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await proc.update(jobContext);

    // Pre-fix: `Buffer === 'true'` was false → flag read as disabled → early
    // return → `update` never called. With the coercion, the flag reads as
    // enabled and the update callback fires.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('treats Buffer("false") as disabled (skips update)', async () => {
    hGet.mockResolvedValue(Buffer.from('false', 'utf8'));
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await proc.update(jobContext);

    expect(update).not.toHaveBeenCalled();
  });

  it('treats string "true" as enabled (legacy single-pod sysRedis, unchanged behavior)', async () => {
    hGet.mockResolvedValue('true');
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await proc.update(jobContext);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('treats null hGet (default) as enabled — `?? "true"` fallback', async () => {
    hGet.mockResolvedValue(null);
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await proc.update(jobContext);

    expect(update).toHaveBeenCalledTimes(1);
  });

  // STEP-3 soft-dependency: a sysRedis DOWN (hGet throws) or SLOW/half-open
  // (withSysReadDeadline rejects) must FAIL OPEN to the absent default (allowed)
  // and keep running the update — never park ~11min or skip on a blip.
  it('FAILS OPEN and still runs the update when sysRedis is DOWN (hGet throws)', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await expect(proc.update(jobContext)).resolves.toBeUndefined(); // no throw escapes
    expect(update).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(1); // fail-open stays observable
  });

  it('FAILS OPEN and still runs the update when the read-deadline REJECTS (SLOW/half-open)', async () => {
    // Model a SLOW/half-open sysRedis: the underlying hGet NEVER settles (it would
    // park ~11min in prod), so ONLY the withSysReadDeadline race can unblock the
    // caller. This PINS the wrap — if the `withSysReadDeadline(...)` wrap were
    // removed (leaving a bare `await sysRedis.hGet`), update() would hang forever
    // and this test would TIME OUT (fail-on-revert). A resolved-hGet mock would
    // pass even without the wrap, so it wouldn't guard the SLOW-path protection.
    hGet.mockReturnValue(new Promise(() => undefined));
    withSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    const update = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({ name: 'TestMetric', update });

    await expect(proc.update(jobContext)).resolves.toBeUndefined();
    expect(withSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });
});

describe('createMetricProcessor — refreshRank() rank flag (Buffer-vs-string)', () => {
  it('treats Buffer("true") as enabled and runs the rank refresh (was silently disabled pre-fix)', async () => {
    hGet.mockResolvedValue(Buffer.from('true', 'utf8'));
    const refresh = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({
      name: 'TestMetric',
      update: vi.fn(),
      rank: { refresh } as any,
    });

    await proc.refreshRank(jobContext);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('treats Buffer("false") as disabled (skips rank refresh)', async () => {
    hGet.mockResolvedValue(Buffer.from('false', 'utf8'));
    const refresh = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({
      name: 'TestMetric',
      update: vi.fn(),
      rank: { refresh } as any,
    });

    await proc.refreshRank(jobContext);

    expect(refresh).not.toHaveBeenCalled();
  });

  // STEP-3 soft-dependency: same fail-open contract as the metric flag.
  it('FAILS OPEN and still runs the rank refresh when sysRedis is DOWN (hGet throws)', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const refresh = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({
      name: 'TestMetric',
      update: vi.fn(),
      rank: { refresh } as any,
    });

    await expect(proc.refreshRank(jobContext)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('FAILS OPEN and still runs the rank refresh when the read-deadline REJECTS (SLOW/half-open)', async () => {
    // hGet never settles (SLOW/half-open park); only the withSysReadDeadline race
    // unblocks. Pins the wrap — a bare `await sysRedis.hGet` would hang and time
    // out this test on revert. See the update() SLOW test for the full rationale.
    hGet.mockReturnValue(new Promise(() => undefined));
    withSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    const refresh = vi.fn(() => Promise.resolve(undefined));
    const proc = createMetricProcessor({
      name: 'TestMetric',
      update: vi.fn(),
      rank: { refresh } as any,
    });

    await expect(proc.refreshRank(jobContext)).resolves.toBeUndefined();
    expect(withSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });
});
