import { beforeEach, describe, expect, it, vi } from 'vitest';

// STEP-3 sysRedis soft-dependency: the daily rewards-abuse-prevention job reads its
// abuse thresholds from sysRedis. This job DISABLES user Buzz rewards (destructive),
// so the fail-open policy here is to SKIP the run (not run on schema defaults) when the
// config read fails — a sysRedis DOWN (hGet throws) or SLOW/half-open (withSysReadDeadline
// rejects) must return early WITHOUT touching clickhouse/dbWrite.

const { hGet, withSysReadDeadline, chQuery, createNotification, refresh, chInsert, logToAxiom } =
  vi.hoisted(() => ({
    hGet: vi.fn(),
    withSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    chQuery: vi.fn(),
    createNotification: vi.fn(() => Promise.resolve(undefined)),
    refresh: vi.fn(() => Promise.resolve(undefined)),
    chInsert: vi.fn(() => Promise.resolve(undefined)),
    logToAxiom: vi.fn(() => Promise.resolve(undefined)),
  }));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet },
  REDIS_SYS_KEYS: { SYSTEM: { FEATURES: 'system:features' } },
  withSysReadDeadline,
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: chQuery, insert: chInsert },
}));

// The dynamic `import('~/server/logging/client')` on the decision-log failure path.
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

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
    expect(result).toEqual({
      dryRun: false,
      minCapDays: 0,
      usersDisabled: 0,
      wouldDisable: 0,
      ipsFlagged: 0,
      sample: [],
    });
  });

  it('treats a Buffer config reply (sentinel mode) as valid JSON', async () => {
    hGet.mockResolvedValue(Buffer.from(JSON.stringify({ awarded: 5000, user_count: 5 }), 'utf8'));

    const result = await rewardsAbusePrevention.run().result;

    expect(chQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      dryRun: false,
      minCapDays: 0,
      usersDisabled: 0,
      wouldDisable: 0,
      ipsFlagged: 0,
      sample: [],
    });
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
// The outer query's own WHERE. Asserting the gate's ABSENCE here is what forbids the placement
// that lets the cluster-size ceiling read a count the gate has already shrunk.
const outerWhereOf = (sql: string) =>
  sql.slice(sql.lastIndexOf('WHERE createdDate'), sql.indexOf('GROUP BY ip'));
type DryRunReport = {
  dryRun: boolean;
  usersDisabled: number;
  wouldDisable: number;
  ipsFlagged: number;
  sample: { ip: string; user_count: number; awarded: number; user_ids: number[] }[];
};
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

  it('emits a startsWith clause for each award-family prefix', async () => {
    await runWith({ award_types: [], award_type_prefixes: ['encouragement:'] });

    expect(sqlOf()).toContain("startsWith(be.type, 'encouragement:')");
  });

  it('emits an always-false predicate rather than none when both type lists are empty', async () => {
    await runWith({ award_types: [], award_type_prefixes: [] });

    expect(sqlOf()).toContain('1 = 0');
  });

  it('emits the exclusivity aggregates and having-clause when exclusivity is on', async () => {
    await runWith({
      require_exclusive_ip: true,
      award_types: [],
      award_type_prefixes: ['encouragement:'],
    });

    const sql = sqlOf();
    expect(sql).toContain('ip_user_count = user_count');
    expect(sql).toContain("uniqExactIf(be.toUserId, startsWith(be.type, 'encouragement:'))");
    // Exact on BOTH sides: the having-clause compares them for equality, and an equality
    // between two HyperLogLog estimates flips on the boundary the test lives on.
    expect(sql).toContain('uniqExact(be.toUserId) as ip_user_count');
    expect(sql).not.toMatch(/uniqIf\(/);
    expect(sql).not.toMatch(/uniq\(be\.toUserId\) as ip_user_count/);
    // The type filter has to leave the WHERE, or the users it hides are the ones
    // exclusivity exists to count.
    expect(sql).not.toContain('AND startsWith');
  });

  it('clusters over the previous COMPLETE day, not whatever is left of today', async () => {
    await runWith({ award_types: ['dailyBoost'] });

    // `createdDate > subtractDays(now(), 1)` reads as "the last 24 hours" and is not: createdDate
    // is a Date, so the comparison lands on midnight and the predicate collapses to "today" —
    // three hours of data at the 03:00 cron, against thresholds that assume a day.
    expect(outerWhereOf(sqlOf())).toContain('createdDate = subtractDays(toDate(now()), 1)');
    expect(outerWhereOf(sqlOf())).not.toContain('createdDate > subtractDays(now(), 1)');
  });

  it('emits a cluster-size ceiling when max_user_count is set', async () => {
    await runWith({ max_user_count: 5 });

    expect(sqlOf()).toContain('AND user_count <= 5');
  });

  it('rejects a config value that would break out of the SQL string', async () => {
    hGet.mockResolvedValue(JSON.stringify({ award_types: ["dailyBoost') OR 1=1 --"] }));

    await expect(rewardsAbusePrevention.run().result).rejects.toThrow(/SQL-significant characters/);
    expect(chQuery).not.toHaveBeenCalled();
  });
});

describe('rewards-abuse-prevention — dry run', () => {
  const abusers = [
    { ip: '203.0.113.7', user_count: 3, ip_user_count: 3, awarded: 300, user_ids: [1, 2, 3] },
  ];

  it('reports what it would disable without touching a single account', async () => {
    chQuery.mockResolvedValue(abusers);

    const result = await runWith({ dryRun: true, require_exclusive_ip: true });

    expect(chQuery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      dryRun: true,
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
    expect(result).toMatchObject({ dryRun: false, usersDisabled: 3 });
  });

  it('reports what it found on the live path too, not only in a dry run', async () => {
    chQuery.mockResolvedValue(abusers);
    dbQueryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = (await runWith({ require_exclusive_ip: true })) as DryRunReport;

    // The fields that say WHAT was found have to survive the switch to enforcing, or a live run
    // that disables nobody cannot be told from one that found nothing.
    expect(result.ipsFlagged).toBe(1);
    expect(result.wouldDisable).toBe(3);
    expect(result.sample).toEqual([
      { ip: '203.0.113.7', user_count: 3, awarded: 300, user_ids: [1, 2, 3] },
    ]);
  });
  it('hands back the flagged clusters, not just a count', async () => {
    chQuery.mockResolvedValue(abusers);

    const result = (await runWith({ dryRun: true })) as DryRunReport;

    expect(result.sample).toEqual([
      { ip: '203.0.113.7', user_count: 3, awarded: 300, user_ids: [1, 2, 3] },
    ]);
  });

  it('caps the sample so a wide run cannot return every cluster it found', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ip: `203.0.113.${i}`,
      user_count: 2,
      ip_user_count: 2,
      awarded: 200,
      user_ids: [i * 2, i * 2 + 1],
    }));
    chQuery.mockResolvedValue(many);

    const result = (await runWith({ dryRun: true })) as DryRunReport;

    expect(result.ipsFlagged).toBe(40);
    expect(result.sample).toHaveLength(25);
  });

  it('counts a user flagged on two IPs once', async () => {
    chQuery.mockResolvedValue([
      { ip: '203.0.113.7', user_count: 2, ip_user_count: 2, awarded: 200, user_ids: [1, 2] },
      { ip: '203.0.113.8', user_count: 2, ip_user_count: 2, awarded: 200, user_ids: [2, 3] },
    ]);

    const result = (await runWith({ dryRun: true })) as DryRunReport;

    expect(result.wouldDisable).toBe(3);
  });
});

describe('rewards-abuse-prevention — scan bounds and config safety', () => {
  it('bounds the scan on the partition-key column, not only on createdDate', async () => {
    await runWith({});

    const sql = sqlOf();
    expect(sql).toContain('createdDate = subtractDays(toDate(now()), 1)');
    // `createdDate` is MATERIALIZED and prunes nothing; without this the scan reads the
    // whole table rather than the window it claims to.
    expect(sql).toContain('time > subtractDays(now(), 3)');
  });

  it('rejects an excluded IP that would break out of the SQL string', async () => {
    hGet.mockResolvedValue(JSON.stringify({ excludedIps: ["1.1.1.1') OR 1=1 --"] }));

    await expect(rewardsAbusePrevention.run().result).rejects.toThrow(/SQL-significant characters/);
    expect(chQuery).not.toHaveBeenCalled();
  });
});

describe('rewards-abuse-prevention — decision log', () => {
  const twoClusters = [
    { ip: '203.0.113.7', user_count: 2, ip_user_count: 2, awarded: 200, user_ids: [1, 2] },
    { ip: '203.0.113.8', user_count: 2, ip_user_count: 2, awarded: 200, user_ids: [3, 4] },
  ];
  type DecisionRow = {
    runId: string;
    ip: string;
    userIds: number[];
    disabledUserIds: number[];
    usersDisabled: number;
  };
  const rowsWritten = () => chInsert.mock.calls[0]?.[0] as { table: string; values: DecisionRow[] };

  it('writes one row per flagged cluster, carrying the config that flagged it', async () => {
    chQuery.mockResolvedValue(twoClusters);

    await runWith({ dryRun: true, require_exclusive_ip: true, user_count: 1, awarded: 100 });

    const { table, values } = rowsWritten();
    expect(table).toBe('rewards_abuse_decisions');
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      ip: '203.0.113.7',
      userIds: [1, 2],
      userCount: 2,
      ipUserCount: 2,
      awarded: 200,
      dryRun: 1,
      requireExclusiveIp: 1,
      userCountThreshold: 1,
      awardedThreshold: 100,
    });
    // One runId for the night, so a run is one query rather than a time range.
    expect(values[0].runId).toBe(values[1].runId);
  });

  it('records nobody as disabled on a dry run', async () => {
    chQuery.mockResolvedValue(twoClusters);

    await runWith({ dryRun: true });

    expect(rowsWritten().values.map((v) => v.disabledUserIds)).toEqual([[], []]);
  });

  it('records only the accounts the update actually changed', async () => {
    chQuery.mockResolvedValue(twoClusters);
    // The flagged set is 1-4; the UPDATE skips 2 (Protected) and 4 (already ineligible).
    dbQueryRawUnsafe.mockResolvedValue([{ id: 1 }, { id: 3 }]);

    await runWith({});

    const values = rowsWritten().values;
    expect(values.map((v) => v.disabledUserIds)).toEqual([[1], [3]]);
    // …and the flagged list is untouched, so the gap between them stays visible.
    expect(values.map((v) => v.userIds)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('still writes a row when the run flagged nothing', async () => {
    chQuery.mockResolvedValue([]);

    await runWith({});

    const values = rowsWritten().values;
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ ip: '', userIds: [], usersDisabled: 0 });
  });

  it('does not fail the job when the log write fails', async () => {
    chQuery.mockResolvedValue(twoClusters);
    dbQueryRawUnsafe.mockResolvedValue([{ id: 1 }]);
    chInsert.mockRejectedValueOnce(new Error('clickhouse unreachable'));

    const result = await runWith({});

    // The accounts are already disabled by this point. Failing here would leave the database
    // changed and the run reported as failed.
    expect(result).toMatchObject({ usersDisabled: 1 });
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: the same write succeeding reports no error', async () => {
    chQuery.mockResolvedValue(twoClusters);
    dbQueryRawUnsafe.mockResolvedValue([{ id: 1 }]);

    await runWith({});

    expect(chInsert).toHaveBeenCalledTimes(1);
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('rewards-abuse-prevention — per-account persistence gate', () => {
  const prefixConfig = {
    require_exclusive_ip: true,
    award_types: [],
    award_type_prefixes: ['encouragement:'],
    cap_day_awarded: 100,
  };

  it('adds nothing at all when min_cap_days is absent', async () => {
    await runWith(prefixConfig);

    expect(sqlOf()).not.toContain('persistent_earners');
  });

  it('CONTROL: the same config with min_cap_days set does add it', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10 });

    expect(sqlOf()).toContain('persistent_earners');
  });

  it('counts a cap-day per user-day over the configured window', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10 });

    const sql = sqlOf();
    expect(sql).toContain('GROUP BY toUserId, day');
    expect(sql).toContain('HAVING countIf(day_awarded >= day_cap) >= 10');
    expect(sql).toContain(
      'createdDate BETWEEN subtractDays(toDate(now()), 30) AND subtractDays(toDate(now()), 1)'
    );
  });

  it('bounds the wider window on the partition key as well as on createdDate', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10, cap_days_window: 14 });

    const sql = sqlOf();
    expect(sql).toContain(
      'createdDate BETWEEN subtractDays(toDate(now()), 14) AND subtractDays(toDate(now()), 1)'
    );
    // Why wider than the window: see DATE_BOUND_SLACK_DAYS.
    expect(sql).toContain('time > subtractDays(now(), 17)');
  });

  it('takes the cap amount from config rather than assuming the encouragement cap', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 3, cap_day_awarded: 250 });

    expect(sqlOf()).toContain('ceil(250 * max(be.multiplier)) AS day_cap');
  });

  it('measures cap-days on the same award types the clustering matches', async () => {
    await runWith({
      require_exclusive_ip: true,
      award_types: ['dailyBoost'],
      award_type_prefixes: [],
      min_cap_days: 10,
      cap_day_awarded: 25,
    });

    // Between the CTE header and its HAVING is the CTE's own WHERE: the type predicate has to
    // be there, or cap-days are counted over every reward the account earns.
    expect(sqlOf()).toMatch(
      /persistent_earners[\s\S]*be\.type IN \('dailyBoost'\)[\s\S]*HAVING countIf/
    );
  });

  it('CONTROL: the same parity holds for a prefix family, not just an exact list', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10 });

    const sql = sqlOf();
    expect(sql).toMatch(
      /persistent_earners[\s\S]*startsWith\(be\.type, 'encouragement:'\)[\s\S]*HAVING countIf/
    );
    // A CTE that hardcoded a type list would satisfy the dailyBoost test above and nothing else.
    expect(sql).not.toContain('be.type IN (');
    // Capped grants store an awardAmount of 0; counting them would make a cap-day out of a day
    // the account spent entirely refused.
    expect(sql).toMatch(/persistent_earners[\s\S]*AND awardAmount > 0[\s\S]*HAVING countIf/);
  });

  it('gates the counted users but NOT the IP total, so a mixed household loses exclusivity', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10 });

    const sql = sqlOf();
    expect(sql).toContain(
      "uniqExactIf(be.toUserId, startsWith(be.type, 'encouragement:') AND be.toUserId IN (SELECT uid FROM persistent_earners)) as user_count"
    );
    // Unfiltered on purpose: `ip_user_count` has to keep counting the casual earners, or the
    // household is reduced to its one persistent user and passes exclusivity instead of failing it.
    expect(sql).toContain('uniqExact(be.toUserId) as ip_user_count');
    expect(sql).toContain('AND ip_user_count = user_count');
    expect(sql).toContain(
      "sumIf(awardAmount, startsWith(be.type, 'encouragement:') AND be.toUserId IN (SELECT uid FROM persistent_earners)) as awarded"
    );
    // The disable list, gated in its own right: without this it is every account that touched the
    // IP, correct only for as long as the equality above survives.
    expect(sql).toContain(
      "groupUniqArrayIf(be.toUserId, startsWith(be.type, 'encouragement:') AND be.toUserId IN (SELECT uid FROM persistent_earners)) as user_ids"
    );
    expect(outerWhereOf(sql)).not.toContain('persistent_earners');
  });

  it('keeps the gate out of the WHERE with exclusivity off too, so the ceiling has a count to read', async () => {
    await runWith({ ...prefixConfig, require_exclusive_ip: false, min_cap_days: 10 });

    const sql = sqlOf();
    expect(sql).toContain(
      'uniqIf(be.toUserId, be.toUserId IN (SELECT uid FROM persistent_earners)) as user_count'
    );
    expect(sql).toContain('uniq(be.toUserId) as ip_user_count');
    // The disable list has to be the gated users, not everyone the WHERE let through.
    expect(sql).toContain(
      'groupUniqArrayIf(be.toUserId, be.toUserId IN (SELECT uid FROM persistent_earners)) as user_ids'
    );
    // The aggregates here take the bare gate, so this branch's award-type filtering exists only
    // in the WHERE: without it `awarded` sums every reward the persistent users earned.
    expect(outerWhereOf(sql)).toContain("startsWith(be.type, 'encouragement:')");
    expect(sql).toContain(
      'sumIf(awardAmount, be.toUserId IN (SELECT uid FROM persistent_earners)) as awarded'
    );
  });

  it('compares the cluster ceiling against a count the gate cannot shrink', async () => {
    await runWith({
      ...prefixConfig,
      require_exclusive_ip: false,
      min_cap_days: 10,
      max_user_count: 5,
    });

    // `user_count` is gated, so an IP too large to be a farm would drop under the ceiling and be
    // flagged for the first time — the one threshold the gate can LOOSEN rather than tighten.
    expect(sqlOf()).toContain('AND ip_user_count <= 5');
    expect(sqlOf()).not.toContain('AND user_count <= 5');
  });

  it('compares the ceiling against the ungated count with exclusivity ON as well', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10, max_user_count: 5 });

    // Equivalent today, because `ip_user_count = user_count` cannot flip false to true when only
    // `user_count` shrinks. Pinned so that relaxing that equality does not silently re-open the
    // ceiling the other branch's fix closed.
    expect(sqlOf()).toContain('AND ip_user_count <= 5');
  });

  it('CONTROL: ungated, the ceiling still reads the matched count it always did', async () => {
    await runWith({ require_exclusive_ip: false, award_types: ['dailyBoost'], max_user_count: 5 });

    expect(sqlOf()).toContain('AND user_count <= 5');
  });

  it('measures the day against the account own multiplied ceiling, not a flat amount', async () => {
    await runWith({ ...prefixConfig, min_cap_days: 10 });

    const sql = sqlOf();
    // A member on a 1.5x multiplier is capped at 150, so 100 paid is not a cap-day. The trimmed
    // grant stores an already-multiplied amount with `multiplier` neutralised to 1.
    expect(sql).toContain(
      'sum(if(be.multiplier = 1, be.awardAmount, ceil(be.awardAmount * be.multiplier))) AS day_awarded'
    );
    expect(sql).toContain('ceil(100 * max(be.multiplier)) AS day_cap');
  });

  it('refuses a threshold with no cap to measure it against', async () => {
    hGet.mockResolvedValue(
      JSON.stringify({
        require_exclusive_ip: true,
        award_types: [],
        award_type_prefixes: ['encouragement:'],
        min_cap_days: 10,
      })
    );

    await expect(rewardsAbusePrevention.run().result).rejects.toThrow(/cap_day_awarded/);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('refuses a window wide enough to fail the run on a query timeout', async () => {
    hGet.mockResolvedValue(
      JSON.stringify({ ...prefixConfig, min_cap_days: 10, cap_days_window: 3650 })
    );

    // Named, so an unrelated validation error cannot stand in for this guard.
    await expect(rewardsAbusePrevention.run().result).rejects.toThrow(/cap_days_window/);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('reports the threshold it ran at, so a quiet run can be told from an ungated one', async () => {
    chQuery.mockResolvedValue([]);

    const result = await runWith({ ...prefixConfig, min_cap_days: 10, dryRun: true });

    expect(result).toMatchObject({ minCapDays: 10 });
  });

  it('rejects a negative threshold rather than emitting a having-clause nothing can fail', async () => {
    hGet.mockResolvedValue(JSON.stringify({ ...prefixConfig, min_cap_days: -1 }));

    await expect(rewardsAbusePrevention.run().result).rejects.toThrow();
    expect(chQuery).not.toHaveBeenCalled();
  });
});
