import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-4 sysRedis soft-dependency sweep — the full-file sweep of
 * `src/server/events/index.ts`.
 *
 * sysRedis ops covered:
 *   - getPartners           lRange     READ   → deadline + fail-open to []
 *   - queueAddRole          lPush      WRITE  → try/catch fail-open (dropped)
 *   - processAddRoleQueue   lLen       READ   → deadline + fail-open → skip
 *   - processAddRoleQueue   lPopCount  READ*  → deadline + fail-open → skip
 *
 * *lPopCount is a DESTRUCTIVE atomic LPOP-with-count. On a fast DOWN the
 * command is never written (disableOfflineQueue + fast reject) so it pops
 * nothing and the queued items STAY on the list for next cycle (#2922
 * non-destructive lesson). CAVEAT: on a slow-but-alive sysRedis the LPOP CAN
 * execute server-side and pop items whose reply then lands after the deadline
 * — those are dropped (a narrow, accepted loss window for best-effort Discord
 * role grants; see the source comment). The SLOW test below models the
 * never-popped sub-case (server never executes), which is what the wrap
 * protects against; it does NOT assert the popped-then-late case is lossless.
 *
 * The SLOW tests are fail-on-revert: the sysRedis op NEVER settles, so if the
 * `withSysReadDeadline(...)` wrap were removed the caller would hang and the
 * test would TIME OUT.
 */

const {
  mockLRange,
  mockLPush,
  mockLLen,
  mockLPopCount,
  mockWithSysReadDeadline,
  mockLogSysRedisFailOpen,
  mockGetDiscordRoles,
  mockGetDiscordIds,
  mockAddRoleToUser,
} = vi.hoisted(() => ({
  mockLRange: vi.fn(),
  mockLPush: vi.fn(),
  mockLLen: vi.fn(),
  mockLPopCount: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockGetDiscordRoles: vi.fn(async () => ({ Team1: 'role-1' } as Record<string, string>)),
  mockGetDiscordIds: vi.fn(async () => new Map<number, string>()),
  mockAddRoleToUser: vi.fn(async () => undefined),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { lRange: mockLRange, lPush: mockLPush, lLen: mockLLen, lPopCount: mockLPopCount },
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), purgeTags: vi.fn() },
  REDIS_KEYS: { EVENT: { EVENT_CLEANUP: 'event:cleanup', BASE: 'event' } },
  REDIS_SUB_KEYS: { EVENT: { PARTNERS: 'partners', ADD_ROLE: 'add-role', CONTRIBUTORS: 'contributors' } },
  REDIS_SYS_KEYS: { EVENT: 'sys:event' },
  withSysReadDeadline: mockWithSysReadDeadline,
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));

// Active event def so `events`/`activeEvents` (computed at module load) is
// non-empty and `processAddRoleQueue` iterates it. Only the fields the three
// functions under test touch are provided.
vi.mock('~/server/events/holiday2024.event', () => ({
  holiday2024: {
    name: 'test-event',
    startDate: new Date('2020-01-01'),
    endDate: new Date('2999-01-01'), // future → active
    getDiscordRoles: mockGetDiscordRoles,
  },
}));

vi.mock('~/server/integrations/discord', () => ({
  discord: {
    getDiscordId: vi.fn(async () => undefined),
    getDiscordIds: mockGetDiscordIds,
    addRoleToUser: mockAddRoleToUser,
  },
}));

// Heavy runtime deps in the module graph — stub so import doesn't pull DB /
// clickhouse / buzz factories.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  getAccountSummary: vi.fn(),
  getTopContributors: vi.fn(),
  getUserBuzzAccount: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));

import { eventEngine } from '~/server/events/index';

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  mockGetDiscordRoles.mockResolvedValue({ Team1: 'role-1' });
  mockGetDiscordIds.mockResolvedValue(new Map<number, string>());
});

describe('getPartners — lRange READ soft-dependency', () => {
  it('happy path: returns parsed partners sorted by amount, through withSysReadDeadline', async () => {
    mockLRange.mockResolvedValue([
      JSON.stringify({ title: 'A', amount: 10, image: '', url: '' }),
      JSON.stringify({ title: 'B', amount: 50, image: '', url: '' }),
    ]);

    const result = await eventEngine.getPartners('test-event');

    expect(result.map((x) => x.title)).toEqual(['B', 'A']); // sorted desc by amount
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: lRange throws → fails open to [], does not throw, logs read-degraded', async () => {
    mockLRange.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await eventEngine.getPartners('test-event');

    expect(result).toEqual([]);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('read-degraded');
    expect(fn).toBe('events.getPartners');
  });

  it('SLOW/half-open: lRange NEVER settles + deadline REJECTS → fails open to [] (fail-on-revert)', async () => {
    mockLRange.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const result = await eventEngine.getPartners('test-event');

    expect(result).toEqual([]);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
  });
});

describe('queueAddRole — lPush WRITE soft-dependency', () => {
  it('happy path: pushes to the queue, no fail-open', async () => {
    mockLPush.mockResolvedValue(1);

    await expect(
      eventEngine.queueAddRole({ event: 'test-event', team: 'Team1', userId: 5 })
    ).resolves.toBeUndefined();

    expect(mockLPush).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: lPush throws → error swallowed (caller does not throw), logs write-degraded', async () => {
    mockLPush.mockRejectedValue(new Error('sysRedis connection is down'));

    await expect(
      eventEngine.queueAddRole({ event: 'test-event', team: 'Team1', userId: 5 })
    ).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, , extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('write-degraded');
    expect(fn).toBe('events.queueAddRole');
    expect(extra).toMatchObject({ event: 'test-event', team: 'Team1', userId: 5 });
  });
});

describe('processAddRoleQueue — lLen + lPopCount READ soft-dependency', () => {
  it('happy path: drains the queue and processes items, no fail-open', async () => {
    mockLLen.mockResolvedValue(1);
    mockLPopCount.mockResolvedValue([JSON.stringify({ team: 'Team1', userId: 7 })]);
    mockGetDiscordIds.mockResolvedValue(new Map<number, string>([[7, 'discord-7']]));

    await expect(eventEngine.processAddRoleQueue()).resolves.toBeUndefined();

    expect(mockLPopCount).toHaveBeenCalledTimes(1);
    expect(mockAddRoleToUser).toHaveBeenCalledWith('discord-7', 'role-1');
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN (lLen throws): skips this cycle without popping → items stay queued, logs read-degraded', async () => {
    mockLLen.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(eventEngine.processAddRoleQueue()).resolves.toBeUndefined();

    // lPopCount must NOT run — a failed lLen means we never destructively drain.
    expect(mockLPopCount).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('events.processAddRoleQueue lLen');
  });

  it('DOWN (lPopCount throws): skips this cycle → queued items not lost, logs read-degraded', async () => {
    mockLLen.mockResolvedValue(2);
    mockLPopCount.mockRejectedValue(new Error('sysRedis connection is down'));

    await expect(eventEngine.processAddRoleQueue()).resolves.toBeUndefined();

    // No items processed (drain failed) — they remain on the list.
    expect(mockAddRoleToUser).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('read-degraded');
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('events.processAddRoleQueue lPopCount');
  });

  it('SLOW/half-open (lLen NEVER settles + deadline REJECTS): skips cycle, no pop (fail-on-revert)', async () => {
    mockLLen.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    await expect(eventEngine.processAddRoleQueue()).resolves.toBeUndefined();

    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLPopCount).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('events.processAddRoleQueue lLen');
  });

  it('SLOW/half-open (lPopCount NEVER settles + deadline REJECTS): skips cycle, no items processed (fail-on-revert; never-popped sub-case)', async () => {
    mockLLen.mockResolvedValue(3);
    mockLPopCount.mockReturnValue(new Promise(() => undefined));
    // lLen resolves (transparent), only the lPopCount race rejects. Make the
    // deadline reject only for the second (lPopCount) call.
    mockWithSysReadDeadline
      .mockImplementationOnce((p) => p) // lLen: transparent
      .mockRejectedValueOnce(new Error('sysRedis read timed out after 2000ms')); // lPopCount

    await expect(eventEngine.processAddRoleQueue()).resolves.toBeUndefined();

    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(2);
    expect(mockAddRoleToUser).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][1]).toBe('events.processAddRoleQueue lPopCount');
  });
});
