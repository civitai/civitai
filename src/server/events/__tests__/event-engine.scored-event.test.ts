import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_STARTS_AT,
  BIRTHDAY_2026_TEAMS,
} from '~/shared/constants/birthday2026.constants';

const { mockCreateNotification, mockRefresh, mockScoring } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockRefresh: vi.fn(async () => undefined),
  mockScoring: {
    getEventStandings: vi.fn(),
    getTeamScoreHistory: vi.fn(),
    runCosmeticPlacementScoring: vi.fn(),
    unequipEventCosmetics: vi.fn(),
  },
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { refresh: vi.fn() },
  cosmeticEntityCaches: new Proxy({}, { get: () => ({ refresh: mockRefresh }) }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  getAccountSummary: vi.fn(),
  getTopContributors: vi.fn(async () => ({})),
  getUserBuzzAccount: vi.fn(async () => [{ balance: 0 }]),
}));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/integrations/discord', () => ({ discord: {} }));
vi.mock('~/server/events/scoring/cosmetic-placement.service', () => mockScoring);

const { events, eventEngine, getActiveEvents } = await import('~/server/events/index');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const HOUR = 60 * 60 * 1000;
const DEPLOY_DAY = new Date('2026-10-09T12:00:00.000Z');
// Cosmetic ids by name, as getCosmetic resolves them through the COSMETICS.IDS hash.
const cosmeticIds: Record<string, string> = {
  'Holiday Garland 2024 - Yellow': '11',
  'Holiday Garland 2024 - Red': '12',
  'Holiday Garland 2024 - Green': '13',
  'Holiday Garland 2024 - Blue': '14',
  'Basic Party Hat - Yellow': '21',
  'Basic Party Hat - Blue': '22',
  'Basic Party Hat - Pink': '23',
  'Basic Party Hat - Green': '24',
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.hGet.mockImplementation(async (_key: string, name: string) => cosmeticIds[name] ?? null);
  redisMock.redis.get.mockResolvedValue(null);
  mockScoring.getEventStandings.mockResolvedValue({
    teams: [
      { team: 'Pink', score: 30, rank: 1 },
      { team: 'Yellow', score: 20, rank: 2 },
      { team: 'Blue', score: 10, rank: 3 },
      { team: 'Green', score: 0, rank: 4 },
    ],
    topCosmetics: [],
    topUsers: {},
    updatedAt: new Date(),
  });
  mockScoring.unequipEventCosmetics.mockResolvedValue([
    { entityType: 'Image', entityId: 5 },
    { entityType: 'Model', entityId: 6 },
  ]);
  mockScoring.runCosmeticPlacementScoring.mockResolvedValue({ synced: 0, scored: [] });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

function anyWrite() {
  return [
    dbMock.dbWrite.userCosmetic.updateMany.mock.calls.length,
    dbMock.dbWrite.$executeRaw.mock.calls.length,
    dbMock.dbWrite.$executeRawUnsafe.mock.calls.length,
    dbMock.dbWrite.$queryRaw.mock.calls.length,
    mockScoring.unequipEventCosmetics.mock.calls.length,
    mockCreateNotification.mock.calls.length,
  ];
}

describe('event registration', () => {
  // The shop fails closed until this registration exists: without this pin, hats could be
  // unbuyable while every suite stays green.
  it('registers the birthday event under its constant name and teams', () => {
    const def = events.find((e) => e.name === BIRTHDAY_2026_EVENT);
    expect(def).toBeDefined();
    expect(def?.teams).toEqual([...BIRTHDAY_2026_TEAMS]);
    expect(def?.startDate.getTime()).toBe(BIRTHDAY_2026_STARTS_AT.getTime());
    expect(def?.endDate.getTime()).toBe(BIRTHDAY_2026_ENDS_AT.getTime());
  });

  it('does not share Date objects with the constants', () => {
    expect(birthday2026.startDate).not.toBe(BIRTHDAY_2026_STARTS_AT);
    expect(birthday2026.endDate).not.toBe(BIRTHDAY_2026_ENDS_AT);
  });

  it('assigns teams exactly as on launch day (golden vector)', async () => {
    // Team = seeded PRNG over (name + userId) indexing the teams array. If this changes after
    // launch, every participant changes team. Do not "update the expected values" to make it
    // pass: find out what moved the name, the seed or the array.
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    const teams = await Promise.all([1, 2, 3, 42, 1000, 123456].map((id) => birthday2026.getUserTeam(id)));
    expect(teams).toEqual(GOLDEN_TEAMS);
  });
});

// Recorded from the real assignment function on 2026-10-09, before launch; see the test above.
const GOLDEN_TEAMS = ['Blue', 'Yellow', 'Blue', 'Pink', 'Pink', 'Pink'];

describe('end-of-event cleanup', () => {
  // 🔴 Pins a deliberate decision: shipping the cleanup fix must not reach back and clean up
  // holiday2024 (or holiday2023, which is not registered). ~1000 Holiday 2024 garlands are still
  // equipped because the old cleanup never ran; whether to remove them is a separate call, not a
  // side effect of this deploy. If you widen getActiveEvents' grace window, this is what breaks.
  it('does nothing for the finished holiday events when run on deploy day', async () => {
    expect(events.map((e) => e.name)).not.toContain('holiday2023');
    expect(getActiveEvents(DEPLOY_DAY).map((e) => e.name)).not.toContain('holiday2024');

    await eventEngine.dailyReset(DEPLOY_DAY);
    await eventEngine.updateLeaderboard(DEPLOY_DAY);

    expect(anyWrite()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('does nothing for holiday2024 on any day after its grace window, including birthday cleanup day', async () => {
    const birthdayCleanup = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 16 * HOUR);
    await eventEngine.dailyReset(birthdayCleanup);

    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    // ...while the birthday event itself was cleaned up (positive control for this run).
    expect(mockScoring.unequipEventCosmetics).toHaveBeenCalledWith(BIRTHDAY_2026_EVENT);
  });

  it('positive control: holiday2024 cleanup does run inside its own grace window, with real cosmetic ids', async () => {
    // Proves the assertions above can see a cleanup: the same observable fires when it should.
    // Also pins the for..in fix: the old loop passed indices "0".."3" to getCosmetic and
    // collected no ids.
    await eventEngine.dailyReset(new Date('2025-01-02T00:00:00.000Z'));

    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith({
      where: { cosmeticId: { in: [11, 12, 13, 14] } },
      data: { equippedAt: null },
    });
  });

  it('clears placements of a scored event, refreshes the content caches and flags the winner', async () => {
    await eventEngine.dailyReset(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 16 * HOUR));

    expect(mockScoring.unequipEventCosmetics).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith([5]);
    expect(mockRefresh).toHaveBeenCalledWith([6]);
    const winnerUpdate = dbMock.dbWrite.$executeRaw.mock.calls.find(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('{winner}')
    );
    expect(winnerUpdate?.[1]).toBe(23); // Pink won
    expect((winnerUpdate?.[0] as TemplateStringsArray).join('?')).toContain("'true'::jsonb");
    expect(redisMock.redis.set).toHaveBeenCalledWith(
      `eventCleanup:${BIRTHDAY_2026_EVENT}`,
      'true',
      expect.anything()
    );
  });

  it('does not clean up twice', async () => {
    redisMock.redis.get.mockResolvedValue('true');
    await eventEngine.dailyReset(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 40 * HOUR));
    expect(mockScoring.unequipEventCosmetics).not.toHaveBeenCalled();
  });
});

describe('scored event is inert before it starts', () => {
  const justBefore = new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1);

  it('runs no scoring, reset or cleanup', async () => {
    await eventEngine.updateLeaderboard(justBefore);
    await eventEngine.dailyReset(justBefore);
    expect(mockScoring.runCosmeticPlacementScoring).not.toHaveBeenCalled();
    expect(anyWrite()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reads as nonexistent', async () => {
    await expect(eventEngine.getEventData(BIRTHDAY_2026_EVENT, justBefore)).rejects.toThrow(
      "That event doesn't exist"
    );
    expect(() => eventEngine.getStartedScoredEvent(BIRTHDAY_2026_EVENT, justBefore)).toThrow(
      "That event doesn't exist"
    );
    expect(eventEngine.getStartedScoredEvent(BIRTHDAY_2026_EVENT, BIRTHDAY_2026_STARTS_AT).name).toBe(
      BIRTHDAY_2026_EVENT
    );
  });

  it('scores from start until a day past the end, then stops', async () => {
    await eventEngine.updateLeaderboard(BIRTHDAY_2026_STARTS_AT);
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 23 * HOUR));
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 25 * HOUR));
    expect(mockScoring.runCosmeticPlacementScoring).toHaveBeenCalledTimes(2);
    // Never the Buzz-bank leaderboard path.
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('join', () => {
  const join = (now: Date) => eventEngine.join(BIRTHDAY_2026_EVENT, 7, now);

  it('is refused outside [STARTS_AT, ENDS_AT)', async () => {
    await expect(join(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1))).rejects.toThrow(
      'This event is not running'
    );
    await expect(join(BIRTHDAY_2026_ENDS_AT)).rejects.toThrow('This event is not running');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('grants the team cosmetic under the join claimKey at the window edges', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({ '7': 'Blue' });
    const first = await join(BIRTHDAY_2026_STARTS_AT);
    const last = await join(new Date(BIRTHDAY_2026_ENDS_AT.getTime() - 1));

    expect(first).toEqual({ team: 'Blue', cosmeticId: 22, joined: true });
    expect(last.joined).toBe(true);
    const [, userId, cosmeticId, claimKey, , , teamIds] = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect([userId, cosmeticId, claimKey]).toEqual([7, 22, 'claimed']);
    expect(teamIds).toEqual([21, 22, 23, 24]);
  });

  it('reports a repeat join as not joined', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    expect((await join(BIRTHDAY_2026_STARTS_AT)).joined).toBe(false);
  });
});
