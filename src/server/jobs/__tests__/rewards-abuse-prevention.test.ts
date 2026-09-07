import { beforeEach, describe, expect, it, vi } from 'vitest';

// STEP-3 sysRedis soft-dependency: the daily rewards-abuse-prevention job reads its
// abuse thresholds from sysRedis. This job DISABLES user Buzz rewards (destructive),
// so the fail-open policy here is to SKIP the run (not run on schema defaults) when the
// config read fails — a sysRedis DOWN (hGet throws) or SLOW/half-open (withSysReadDeadline
// rejects) must return early WITHOUT touching clickhouse/dbWrite.

const { hGet, withSysReadDeadline, chQuery, createNotification, refresh } = vi.hoisted(() => ({
  hGet: vi.fn(),
  withSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  chQuery: vi.fn(),
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
import { dbMock } from '~/__tests__/mocks/db.mock';
const dbQueryRawUnsafe = dbMock.dbWrite.$queryRawUnsafe;

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
    hGet.mockResolvedValue(Buffer.from(JSON.stringify({ awarded: 5000, user_count: 5 }), 'utf8'));

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

const sqlOf = () => (chQuery.mock.calls[0]?.[0] as string) ?? '';
const runWith = (config: Record<string, unknown>) => {
  hGet.mockResolvedValue(JSON.stringify(config));
  return rewardsAbusePrevention.run().result;
};

describe('rewards-abuse-prevention — detection shape', () => {
  it('adds none of the new clauses when the new options are absent', async () => {
    await runWith({ award_types: ['dailyBoost'] });

    const sql = sqlOf();
    expect(sql).toContain("AND be.type IN ('dailyBoost')");
    expect(sql).not.toContain('uniqIf');
    expect(sql).not.toContain('ip_user_count = user_count');
    expect(sql).not.toContain('startsWith');
    expect(sql).not.toContain('user_count <=');
  });

  it('matches a whole award family by prefix', async () => {
    await runWith({ award_types: [], award_type_prefixes: ['encouragement:'] });

    expect(sqlOf()).toContain("startsWith(be.type, 'encouragement:')");
  });

  it('matches nothing rather than everything when both type lists are empty', async () => {
    await runWith({ award_types: [], award_type_prefixes: [] });

    expect(sqlOf()).toContain('1 = 0');
  });

  it('requires the IP to carry no other earning users when exclusivity is on', async () => {
    await runWith({
      require_exclusive_ip: true,
      award_types: [],
      award_type_prefixes: ['encouragement:'],
    });

    const sql = sqlOf();
    expect(sql).toContain('ip_user_count = user_count');
    expect(sql).toContain("uniqIf(be.toUserId, startsWith(be.type, 'encouragement:'))");
    // The type filter has to leave the WHERE, or the users it hides are the ones
    // exclusivity exists to count.
    expect(sql).not.toContain('AND startsWith');
  });

  it('caps cluster size when max_user_count is set', async () => {
    await runWith({ max_user_count: 5 });

    expect(sqlOf()).toContain('AND user_count <= 5');
  });

  it('rejects a config value that would break out of the SQL string', async () => {
    hGet.mockResolvedValue(JSON.stringify({ award_types: ["dailyBoost') OR 1=1 --"] }));

    await expect(rewardsAbusePrevention.run().result).rejects.toThrow();
    expect(chQuery).not.toHaveBeenCalled();
  });
});

describe('rewards-abuse-prevention — report mode', () => {
  const abusers = [
    { ip: '203.0.113.7', user_count: 3, ip_user_count: 3, awarded: 300, user_ids: [1, 2, 3] },
  ];

  it('reports what it would disable without touching a single account', async () => {
    chQuery.mockResolvedValue(abusers);

    const result = await runWith({ mode: 'report', require_exclusive_ip: true });

    expect(chQuery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: 'report',
      usersDisabled: 0,
      wouldDisable: 3,
      ipsFlagged: 1,
    });
    expect(dbQueryRawUnsafe).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('CONTROL: the same finding in enforce mode does disable them', async () => {
    chQuery.mockResolvedValue(abusers);
    dbQueryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await runWith({ require_exclusive_ip: true });

    expect(dbQueryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersDisabled: 3 });
  });
});
