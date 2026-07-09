import { beforeEach, describe, expect, it, vi } from 'vitest';

// STEP-3 sysRedis soft-dependency: the daily rewards-abuse-prevention job reads its
// abuse thresholds from sysRedis. This job DISABLES user Buzz rewards (destructive),
// so the fail-open policy here is to SKIP the run (not run on schema defaults) when the
// config read fails — a sysRedis DOWN (hGet throws) or SLOW/half-open (withSysReadDeadline
// rejects) must return early WITHOUT touching clickhouse/dbWrite.

const { hGet, withSysReadDeadline, chQuery, dbQueryRawUnsafe, createNotification, refresh } =
  vi.hoisted(() => ({
    hGet: vi.fn(),
    withSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    chQuery: vi.fn(),
    dbQueryRawUnsafe: vi.fn(),
    createNotification: vi.fn(() => Promise.resolve(undefined)),
    refresh: vi.fn(() => Promise.resolve(undefined)),
  }));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet },
  REDIS_SYS_KEYS: { SYSTEM: { FEATURES: 'system:features' } },
  withSysReadDeadline,
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: chQuery },
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $queryRawUnsafe: dbQueryRawUnsafe },
}));

vi.mock('~/server/redis/caches', () => ({
  userMultipliersCache: { refresh },
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification,
}));

// The dynamic `import('~/server/prom/client')` inside the task loop.
vi.mock('~/server/prom/client', () => ({
  userUpdateCounter: { inc: vi.fn() },
}));

// Testable createJob: run().result invokes fn directly (mirrors process-strikes.test.ts).
vi.mock('~/server/jobs/job', () => ({
  createJob: (_name: string, _cron: string, fn: any) => ({
    name: _name,
    cron: _cron,
    run: (opts?: { req?: any }) => ({
      result: fn({ status: 'running', on: vi.fn(), checkIfCanceled: vi.fn(), req: opts?.req }),
      cancel: vi.fn(),
    }),
  }),
}));

import { rewardsAbusePrevention } from '~/server/jobs/rewards-abuse-prevention';

beforeEach(() => {
  vi.clearAllMocks();
  withSysReadDeadline.mockImplementation((p) => p); // transparent by default
  chQuery.mockResolvedValue([]); // no abusers by default
  dbQueryRawUnsafe.mockResolvedValue([]);
});

describe('rewards-abuse-prevention — sysRedis config read (STEP-3 soft-dependency)', () => {
  it('runs detection with a valid config (happy path)', async () => {
    hGet.mockResolvedValue(
      JSON.stringify({ awarded: 5000, user_count: 5, award_types: ['dailyBoost'] })
    );

    const result = await rewardsAbusePrevention.run().result;

    expect(chQuery).toHaveBeenCalledTimes(1); // detection query ran
    expect(result).toEqual({ usersDisabled: 0 });
  });

  it('treats a Buffer config reply (sentinel mode) as valid JSON', async () => {
    hGet.mockResolvedValue(
      Buffer.from(JSON.stringify({ awarded: 5000, user_count: 5 }), 'utf8')
    );

    const result = await rewardsAbusePrevention.run().result;

    expect(chQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersDisabled: 0 });
  });

  it('SKIPS the run (no destructive detection) when sysRedis is DOWN (hGet throws)', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await rewardsAbusePrevention.run().result;

    expect(result).toEqual({ usersDisabled: 0, skipped: 'sysRedis-config-read-failed' });
    expect(chQuery).not.toHaveBeenCalled(); // never queried abusers
    expect(dbQueryRawUnsafe).not.toHaveBeenCalled(); // never ran the destructive UPDATE
  });

  it('SKIPS the run when the read-deadline REJECTS (SLOW/half-open)', async () => {
    withSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await rewardsAbusePrevention.run().result;

    expect(result).toEqual({ usersDisabled: 0, skipped: 'sysRedis-config-read-failed' });
    expect(chQuery).not.toHaveBeenCalled();
    expect(dbQueryRawUnsafe).not.toHaveBeenCalled();
  });
});
