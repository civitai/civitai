import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
  BIRTHDAY_2026_TEAMS,
} from '~/shared/constants/birthday2026.constants';
import { EVENT_DECORATION_DEFINITIONS } from '~/shared/constants/event-decoration.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

const { mockCreateNotification, mockRefresh, mockScoring, mockReferee, mockSync } = vi.hoisted(
  () => ({
    mockCreateNotification: vi.fn(),
    mockRefresh: vi.fn<(type: string, ids: number[]) => Promise<undefined>>(async () => undefined),
    mockScoring: {
      getEventStandings: vi.fn(),
      getTeamScoreHistory: vi.fn(),
      hasStandingsSnapshot: vi.fn<(event: unknown) => Promise<boolean>>(async () => false),
      refreshStandings: vi.fn(),
    },
    mockReferee: { runEventPointsReferee: vi.fn() },
    mockSync: { syncEventHats: vi.fn() },
  })
);
const killSwitch = vi.hoisted(() => ({ on: true }));

// The engine's kill switch is on unless a test turns it off.
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => killSwitch.on,
  isEventPointsEnabledSync: () => killSwitch.on,
  onEventPointsSwitchOn: () => () => undefined,
}));
// The engine's self-heal runs the reconcile and settle: tested in self-heal.test.ts, not here.
vi.mock('~/server/events/points/self-heal', () => ({ healEventPoints: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { refresh: vi.fn() },
  cosmeticEntityCaches: new Proxy({}, { get: () => ({ refresh: vi.fn() }) }),
  eventDecorationEntityCaches: new Proxy(
    {},
    { get: (_t, type: string) => ({ refresh: (ids: number[]) => mockRefresh(type, ids) }) }
  ),
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
vi.mock('~/server/events/points/referee', () => mockReferee);
vi.mock('~/server/events/points/sync', () => mockSync);
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { events, eventEngine, getActiveEvents } = await import('~/server/events/index');
const { birthday2026 } = await import('~/server/events/birthday2026.event');

const HOUR = 60 * 60 * 1000;
let redisStore: Record<string, string> = {};
// The options each key was last set with, so expiries are checked, not assumed.
let redisSetOptions: Record<string, unknown> = {};
const MARKER_TTL = { EX: 30 * 24 * 60 * 60 };
// The winner record lives in sysRedis.
let sysStore: Record<string, string> = {};
let sysSetOptions: Record<string, unknown> = {};
const DEPLOY_DAY = new Date('2026-10-09T12:00:00.000Z');
// Cosmetic ids as the COSMETICS.IDS hash caches them: by name for the holiday events, by
// event:design:team for join events (which look the cosmetic up by data, never by name).
const cosmeticIds: Record<string, string> = {
  'Holiday Garland 2024 - Yellow': '11',
  'Holiday Garland 2024 - Red': '12',
  'Holiday Garland 2024 - Green': '13',
  'Holiday Garland 2024 - Blue': '14',
  'birthday2026:basic:Yellow': '21',
  'birthday2026:basic:Blue': '22',
  'birthday2026:basic:Pink': '23',
  'birthday2026:basic:Green': '24',
};

beforeEach(() => {
  vi.clearAllMocks();
  killSwitch.on = true;
  // Launched unless a test says otherwise; who the flag lets in is pinned in event-access.test.ts.
  testerFlag.reset({ public: true });
  redisMock.redis.hGet.mockImplementation(
    async (_key: string, name: string) => cosmeticIds[name] ?? null
  );
  redisStore = {};
  redisSetOptions = {};
  redisMock.redis.get.mockImplementation(async (key: string) => redisStore[key] ?? null);
  redisMock.redis.set.mockImplementation(async (key: string, value: string, options?: unknown) => {
    redisStore[key] = value;
    redisSetOptions[key] = options;
    return 'OK';
  });
  sysStore = {};
  sysSetOptions = {};
  redisMock.sysRedis.get.mockImplementation(async (key: string) => sysStore[key] ?? null);
  redisMock.sysRedis.set.mockImplementation(
    async (key: string, value: string, options?: unknown) => {
      sysStore[key] = value;
      sysSetOptions[key] = options;
      return 'OK';
    }
  );
  const standings = {
    teams: [
      { team: 'Pink', score: 30, rank: 1 },
      { team: 'Yellow', score: 20, rank: 2 },
      { team: 'Blue', score: 10, rank: 3 },
      { team: 'Green', score: 0, rank: 4 },
    ],
    topCosmetics: [],
    topUsers: {},
    updatedAt: new Date(),
  };
  mockScoring.getEventStandings.mockResolvedValue(standings);
  mockScoring.refreshStandings.mockResolvedValue(standings);
  mockReferee.runEventPointsReferee.mockResolvedValue({ season: 'live', rows: 0, changed: 0 });
  mockScoring.hasStandingsSnapshot.mockResolvedValue(false);
  mockSync.syncEventHats.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

function anyWrite() {
  return [
    dbMock.dbWrite.userCosmetic.updateMany.mock.calls.length,
    dbMock.dbWrite.$executeRaw.mock.calls.length,
    dbMock.dbWrite.$executeRawUnsafe.mock.calls.length,
    dbMock.dbWrite.$queryRaw.mock.calls.length,
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

  // The champion badge art as uploaded to the CDN and checked there, so an accidental edit to an id
  // (a broken image on the prize banner) fails here.
  it('names the uploaded prize badge art for every team, animated and still', () => {
    expect(birthday2026.page?.prizeBadge).toEqual({
      Yellow: {
        animated: '5cf4f411-bb05-4afc-86b9-0ce9fbd8c683',
        static: 'c447b59d-bc02-4e7f-a83b-ad1efe3a70cf',
      },
      Blue: {
        animated: 'd0aedf96-8bb4-4837-9e22-f13662391e98',
        static: 'aa5ee01e-dfee-458a-9431-16c5e8656754',
      },
      Pink: {
        animated: '54cec518-332c-49cb-8584-359df0ff2ff8',
        static: '271a8ed5-46ae-47bc-8e63-7f913859bd3b',
      },
      Green: {
        animated: '3d5d9dea-c84a-4801-bf95-78dae8731010',
        static: '0c6d2d0a-ab63-45ee-925f-4019ee78db20',
      },
    });
    expect(Object.keys(birthday2026.page?.prizeBadge ?? {})).toEqual([...BIRTHDAY_2026_TEAMS]);
  });

  // The page once said "Move it whenever you like" while placement enforced a 10-minute wait.
  it("states the move wait that placement enforces in the page's placing step", () => {
    const { moveCooldownMs } = EVENT_DECORATION_DEFINITIONS.find(
      (d) => d.event === BIRTHDAY_2026_EVENT
    )!;
    expect(moveCooldownMs).toBe(10 * 60_000);
    expect(birthday2026.page?.steps[1]).toEqual({
      title: 'Hat your best work',
      body: 'Each hat sits on one of your own posts at a time, alongside any frame. Move it any time, with a 10-minute wait between moves.',
    });
  });

  it('assigns teams exactly as on launch day (golden vector)', async () => {
    // Team = seeded PRNG over (name + userId) indexing the teams array. If this changes after
    // launch, every participant changes team. Do not "update the expected values" to make it
    // pass: find out what moved the name, the seed or the array.
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    const teams = await Promise.all(GOLDEN_USER_IDS.map((id) => birthday2026.getUserTeam(id)));
    expect(teams).toEqual(GOLDEN_TEAMS);
  });

  // Justin, 2026-10-09: the test run before launch keeps its hats, on the condition that "the teams
  // will be the same between test and launch". A team is a function of the event name and user id
  // only; if you are adding the date, the flag or the preview to it, the hats testers bought
  // become the wrong colour at launch.
  it('assigns the same team during the preview, at launch and after, whatever the flag says', async () => {
    redisMock.sysRedis.hGetAll.mockResolvedValue({});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const moments = [
        BIRTHDAY_2026_PREVIEW_FROM,
        new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1),
        BIRTHDAY_2026_STARTS_AT,
        BIRTHDAY_2026_ENDS_AT,
      ];
      for (const now of moments) {
        for (const isPublic of [false, true]) {
          vi.setSystemTime(now);
          testerFlag.reset({ public: isPublic, testers: GOLDEN_USER_IDS });
          const teams = await Promise.all(
            GOLDEN_USER_IDS.map((id) => birthday2026.getUserTeam(id))
          );
          expect(teams).toEqual(GOLDEN_TEAMS);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// Recorded from the real assignment function on 2026-10-09, before launch; see the test above.
const GOLDEN_USER_IDS = [1, 2, 3, 42, 1000, 123456, 4, 5, 6, 7, 8, 9, 10, 11, 12];
// The first six were recorded on 2026-10-09; ids 4-12 were added later so every team appears.
const GOLDEN_TEAMS = [
  'Blue',
  'Yellow',
  'Blue',
  'Pink',
  'Pink',
  'Pink',
  'Green',
  'Blue',
  'Blue',
  'Yellow',
  'Yellow',
  'Green',
  'Green',
  'Green',
  'Yellow',
];

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

    expect(anyWrite()).toEqual([0, 0, 0, 0, 0]);
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('keeps an ended event eligible for cleanup for exactly 7 days', () => {
    // Pinned at the boundary, not just at deploy day: a widened grace window is how a later change
    // would start reaching back into finished events.
    const holiday = events.find((e) => e.name === 'holiday2024')!;
    const edge = holiday.endDate.getTime() + 7 * 24 * HOUR;
    expect(getActiveEvents(new Date(edge)).map((e) => e.name)).toContain('holiday2024');
    expect(getActiveEvents(new Date(edge + 1)).map((e) => e.name)).not.toContain('holiday2024');
  });

  it('does nothing for holiday2024 on any day after its grace window, including birthday cleanup day', async () => {
    const birthdayCleanup = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 40 * HOUR);
    sysStore[`event:${BIRTHDAY_2026_EVENT}:winner`] = 'Pink';
    await eventEngine.dailyReset(birthdayCleanup);

    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    // ...while the birthday event itself was cleaned up on this same run (positive control).
    expect(redisMock.redis.set.mock.calls.map(([key]) => key)).toEqual([
      `eventCleanup:${BIRTHDAY_2026_EVENT}`,
    ]);
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
    // An unscored event's cleanup still flags its own winner: Yellow, first of four tied at zero.
    const flagged = dbMock.dbWrite.$executeRaw.mock.calls.filter(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('{winner}')
    );
    expect(flagged.map(([, id]) => id)).toEqual([11]);
  });

  const firstReset = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 16 * HOUR);
  const secondReset = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 40 * HOUR);
  const winnerUpdates = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.filter(([sql]) =>
      (sql as TemplateStringsArray).join('?').includes('{winner}')
    );
  const setKeys = () => redisMock.redis.set.mock.calls.map(([key]) => key);

  // Justin and Ellie, 2026-10-09: hats are kept after the event. The end-of-event reset used to take
  // every hat off content; it must not. See event-decoration-equip.test.ts for wearing them after.
  it('leaves cosmetics on content after the end, and decides no winner while scoring takes late data', async () => {
    await eventEngine.dailyReset(firstReset);

    expect(anyWrite()).toEqual([0, 0, 0, 0, 0]);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  const close = BIRTHDAY_2026_ENDS_AT.getTime() + birthday2026.scoring!.finalizeAfterMs;
  const winnerMarker = `event:${BIRTHDAY_2026_EVENT}:winner`;
  // The referee reports a run final once it settles the whole finalize window.
  const finalRun = () =>
    mockReferee.runEventPointsReferee.mockResolvedValueOnce({
      season: 'live',
      rows: 0,
      changed: 0,
      final: true,
    });

  it('names no winner while switched off, though it still snapshots, and names it once back on', async () => {
    killSwitch.on = false;
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(1);
    expect(winnerUpdates()).toHaveLength(0);
    expect(sysStore[winnerMarker]).toBeUndefined();

    killSwitch.on = true;
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(sysStore[winnerMarker]).toBe('Pink');
  });

  it('names the winner on the first run that settles the whole finalize window', async () => {
    await eventEngine.updateLeaderboard(new Date(close));
    expect(winnerUpdates()).toHaveLength(0);
    expect(sysStore[winnerMarker]).toBeUndefined();

    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    const [update] = winnerUpdates();
    expect(update?.[1]).toBe(23); // Pink won
    expect((update?.[0] as TemplateStringsArray).join('?')).toContain("'true'::jsonb");
    expect(sysStore[winnerMarker]).toBe('Pink');
    // Outlives the 7-day grace window, so later runs keep seeing it and stop.
    expect(sysSetOptions[winnerMarker]).toEqual(MARKER_TTL);
  });

  // The winner is read from the standings this run computed on the primary, never the stored
  // snapshot a failed or earlier run left.
  it('names the winner from the standings the final run computed, not the cached snapshot', async () => {
    mockScoring.refreshStandings.mockResolvedValue({
      teams: [
        { team: 'Blue', score: 40, rank: 1 },
        { team: 'Pink', score: 30, rank: 2 },
      ],
      topCosmetics: [],
      topUsers: {},
      updatedAt: new Date(),
    });
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    expect(winnerUpdates().map(([, id]) => id)).toEqual([22]);
    expect(sysStore[winnerMarker]).toBe('Blue');
  });

  it('keeps settling past the window until a run is final, then stops', async () => {
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(2);
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + 3 * HOUR));
    await eventEngine.updateLeaderboard(new Date(close + 4 * HOUR));
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(3);
    expect(winnerUpdates()).toHaveLength(1);
  });

  it('names no winner when the final run cannot compute its standings, and the next run does', async () => {
    mockScoring.refreshStandings.mockRejectedValueOnce(new Error('db down'));
    finalRun();
    await expect(eventEngine.updateLeaderboard(new Date(close + HOUR))).rejects.toThrow('db down');
    expect(winnerUpdates()).toHaveLength(0);
    expect(sysStore[winnerMarker]).toBeUndefined();
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(winnerUpdates()).toHaveLength(1);
  });

  it('names no winner from a failed run, and the next run tries again', async () => {
    mockReferee.runEventPointsReferee.mockRejectedValueOnce(new Error('clickhouse down'));
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    expect(winnerUpdates()).toHaveLength(0);
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(winnerUpdates()).toHaveLength(1);
  });

  it('names no winner while the engine is switched off, and does once it is back on', async () => {
    killSwitch.on = false;
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    expect(mockReferee.runEventPointsReferee).not.toHaveBeenCalled();
    expect(winnerUpdates()).toHaveLength(0);

    killSwitch.on = true;
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(winnerUpdates().map(([, id]) => id)).toEqual([23]);
  });

  it('ends scoring on a final run with no first-place team, naming no winner', async () => {
    mockScoring.refreshStandings.mockResolvedValue({
      teams: [],
      topCosmetics: [],
      topUsers: {},
      updatedAt: new Date(),
    });
    finalRun();
    await eventEngine.updateLeaderboard(new Date(close + HOUR));
    await eventEngine.updateLeaderboard(new Date(close + 2 * HOUR));
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(1);
    expect(winnerUpdates()).toHaveLength(0);
    expect(sysSetOptions[winnerMarker]).toEqual(MARKER_TTL);

    // ...and the cleanup, as before, has no winner to clean up with.
    await eventEngine.dailyReset(secondReset);
    expect(setKeys()).not.toContain(`eventCleanup:${BIRTHDAY_2026_EVENT}`);
  });

  it('does not mark the winner named when flagging it fails', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('db down'));
    finalRun();
    await expect(eventEngine.updateLeaderboard(new Date(close + HOUR))).rejects.toThrow('db down');
    expect(sysStore[winnerMarker]).toBeUndefined();
  });

  it('cleans up only once the winner is named, with the recorded winner, without flagging it again', async () => {
    const onCleanup = vi.fn(async () => undefined);
    const def = birthday2026 as { onCleanup?: unknown };
    def.onCleanup = onCleanup;
    try {
      await eventEngine.dailyReset(secondReset);
      expect(setKeys()).toEqual([]);

      // Blue is not first in the standings: the record, not the standings, decides.
      sysStore[winnerMarker] = 'Blue';
      await eventEngine.dailyReset(secondReset);
      expect(onCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ winner: 'Blue', winnerCosmeticId: 22 })
      );
      expect(winnerUpdates()).toHaveLength(0);
      const cleanupMarker = `eventCleanup:${BIRTHDAY_2026_EVENT}`;
      expect(setKeys()).toEqual([cleanupMarker]);
      expect(redisSetOptions[cleanupMarker]).toEqual(MARKER_TTL);
    } finally {
      delete def.onCleanup;
    }
  });

  it('waits to clean up while the engine is switched off', async () => {
    sysStore[winnerMarker] = 'Pink';
    killSwitch.on = false;
    await eventEngine.dailyReset(secondReset);
    expect(setKeys()).toEqual([]);
  });

  it('does not clean up twice', async () => {
    redisMock.redis.get.mockResolvedValue('true');
    await eventEngine.dailyReset(secondReset);
    expect(winnerUpdates()).toHaveLength(0);
    expect(setKeys()).toEqual([]);
  });
});

describe('scored team reads', () => {
  it('hands the degraded callback to the settled standings read', async () => {
    const onDegraded = vi.fn();
    await eventEngine.getTeamScores(BIRTHDAY_2026_EVENT, 'open', { onDegraded });
    await eventEngine.getTeamScoreHistory({ event: BIRTHDAY_2026_EVENT }, 'open', { onDegraded });
    expect(mockScoring.getEventStandings).toHaveBeenCalledWith(
      expect.objectContaining({ name: BIRTHDAY_2026_EVENT }),
      { onDegraded }
    );
    expect(mockScoring.getTeamScoreHistory).toHaveBeenCalledWith(
      expect.objectContaining({ name: BIRTHDAY_2026_EVENT }),
      { onDegraded }
    );
  });
});

describe('scored event is inert before it starts', () => {
  const justBefore = new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1);
  const beforePreview = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1);

  // Armed: the base is on before the start, so the preview is over and nothing runs until launch.
  it('runs no scoring, reset or cleanup once armed, or before the preview', async () => {
    await eventEngine.updateLeaderboard(justBefore);
    await eventEngine.dailyReset(justBefore);
    testerFlag.reset({ public: false });
    await eventEngine.updateLeaderboard(beforePreview);
    await eventEngine.dailyReset(beforePreview);
    expect(mockReferee.runEventPointsReferee).not.toHaveBeenCalled();
    expect(anyWrite()).toEqual([0, 0, 0, 0, 0]);
  });

  it('reads as nonexistent to the public', async () => {
    await expect(
      eventEngine.getEventData(BIRTHDAY_2026_EVENT, undefined, justBefore)
    ).rejects.toThrow("That event doesn't exist");
    await expect(
      eventEngine.getReadableScoredEvent(BIRTHDAY_2026_EVENT, { id: 7 }, justBefore)
    ).rejects.toThrow("That event doesn't exist");
    expect(
      (
        await eventEngine.getReadableScoredEvent(
          BIRTHDAY_2026_EVENT,
          undefined,
          BIRTHDAY_2026_STARTS_AT
        )
      ).name
    ).toBe(BIRTHDAY_2026_EVENT);
  });

  it('scores from the start until the winner is named, then stops', async () => {
    await eventEngine.updateLeaderboard(BIRTHDAY_2026_STARTS_AT);
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 23 * HOUR));
    sysStore[`event:${BIRTHDAY_2026_EVENT}:winner`] = 'Pink';
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 25 * HOUR));
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(2);
    // Never the Buzz-bank leaderboard path.
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('join', () => {
  const join = (now: Date) => eventEngine.join(BIRTHDAY_2026_EVENT, { id: 7 }, now);

  it('is refused outside [STARTS_AT, ENDS_AT), reading as nonexistent before the start', async () => {
    await expect(join(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1))).rejects.toThrow(
      "That event doesn't exist"
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

  it('reports a repeat join as not joined, with the cosmetic actually held', async () => {
    // Joined as Blue, since reassigned to Pink by hand.
    redisMock.sysRedis.hGetAll.mockResolvedValue({ '7': 'Pink' });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ cosmeticId: 22 }]);
    expect(await join(BIRTHDAY_2026_STARTS_AT)).toEqual({
      team: 'Blue',
      cosmeticId: 22,
      joined: false,
    });
  });
});

describe('join team lookup', () => {
  it('refuses to join when the manual team assignments cannot be read', async () => {
    redisMock.sysRedis.hGetAll.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      eventEngine.join(BIRTHDAY_2026_EVENT, { id: 7 }, BIRTHDAY_2026_STARTS_AT)
    ).rejects.toThrow('ECONNREFUSED');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

// The hourly job hands the scorer the window and audience the access rule decided (event-access.ts
// pins the rule itself; this pins that the engine passes it on).
describe('scoring behind the flag', () => {
  const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * HOUR);
  const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * HOUR);
  const settled = () =>
    mockReferee.runEventPointsReferee.mock.calls.map(([e, season]) => ({ name: e.name, season }));
  const standingsFrom = () =>
    mockScoring.refreshStandings.mock.calls.map(([e]) => (e as { scoreFrom: Date }).scoreFrom);

  // Which owners' hats earn in the preview is the hat sync's job (it applies the flag); this pins that
  // the preview is settled as its own season, with standings read from the preview's start.
  it('settles the preview as its own season, syncing hats first', async () => {
    testerFlag.reset({ public: false });
    await eventEngine.updateLeaderboard(PREVIEW);
    expect(mockSync.syncEventHats).toHaveBeenCalledWith(PREVIEW);
    expect(settled()).toEqual([{ name: BIRTHDAY_2026_EVENT, season: 'preview' }]);
    expect(standingsFrom()).toEqual([BIRTHDAY_2026_PREVIEW_FROM]);
  });

  // Standings are rebuilt right after the referee writes the snapshot: a replica may not have it yet.
  it('syncs hats before settling, then rebuilds standings from the primary', async () => {
    await eventEngine.updateLeaderboard(DURING);
    const [synced] = mockSync.syncEventHats.mock.invocationCallOrder;
    const [refereed] = mockReferee.runEventPointsReferee.mock.invocationCallOrder;
    const [refreshed] = mockScoring.refreshStandings.mock.invocationCallOrder;
    expect(synced).toBeLessThan(refereed);
    expect(refereed).toBeLessThan(refreshed);
    expect(mockScoring.refreshStandings.mock.calls[0][1]).toBe(dbMock.dbWrite);
  });

  // Off, a scored event settles nothing (no hat sync, no referee, so no ClickHouse read and no push)
  // and must not fall through to the old donor leaderboard. It only snapshots the durable table, so
  // the pages show the last settled numbers.
  it('settles nothing while the engine is switched off, but still snapshots the standings', async () => {
    killSwitch.on = false;
    await eventEngine.updateLeaderboard(DURING);
    expect(mockSync.syncEventHats).not.toHaveBeenCalled();
    expect(mockReferee.runEventPointsReferee).not.toHaveBeenCalled();
    expect(mockScoring.refreshStandings.mock.calls).toEqual([
      [expect.objectContaining({ name: BIRTHDAY_2026_EVENT }), dbMock.dbWrite],
    ]);
    expect(standingsFrom()).toEqual([BIRTHDAY_2026_STARTS_AT]);
    expect(anyWrite()).toEqual([0, 0, 0, 0, 0]);

    killSwitch.on = true;
    await eventEngine.updateLeaderboard(DURING);
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(1);
  });

  // Nothing more can settle while off once the window has closed: one snapshot there is enough.
  it('snapshots once past the window while switched off, then stops', async () => {
    killSwitch.on = false;
    const past = new Date(
      BIRTHDAY_2026_ENDS_AT.getTime() + birthday2026.scoring!.finalizeAfterMs + 1
    );
    await eventEngine.updateLeaderboard(past);
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(1);
    mockScoring.hasStandingsSnapshot.mockResolvedValueOnce(true);
    await eventEngine.updateLeaderboard(past);
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(1);
    expect(mockScoring.hasStandingsSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
      name: BIRTHDAY_2026_EVENT,
      scoreFrom: BIRTHDAY_2026_STARTS_AT,
    });
    // During the season the snapshot is refreshed every run, stored or not.
    mockScoring.hasStandingsSnapshot.mockResolvedValue(true);
    await eventEngine.updateLeaderboard(DURING);
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(2);
    // Switched on, past the window it keeps settling until a run is final, stored snapshot or not.
    killSwitch.on = true;
    await eventEngine.updateLeaderboard(past);
    expect(mockReferee.runEventPointsReferee).toHaveBeenCalledTimes(1);
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(3);
  });

  it('snapshots the preview from its own start while switched off, and nothing outside the window', async () => {
    killSwitch.on = false;
    testerFlag.reset({ public: false });
    await eventEngine.updateLeaderboard(PREVIEW);
    expect(standingsFrom()).toEqual([BIRTHDAY_2026_PREVIEW_FROM]);
    const finalize = birthday2026.scoring!.finalizeAfterMs;
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1));
    // Past the window once a winner is on record, nothing runs at all.
    sysStore[`event:${BIRTHDAY_2026_EVENT}:winner`] = 'Pink';
    await eventEngine.updateLeaderboard(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + finalize + 1));
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(1);
    expect(mockSync.syncEventHats).not.toHaveBeenCalled();
    expect(mockReferee.runEventPointsReferee).not.toHaveBeenCalled();
  });

  it('still refreshes the standings when the referee fails', async () => {
    const { logToAxiom } = await import('~/server/logging/client');
    mockReferee.runEventPointsReferee.mockRejectedValueOnce(new Error('clickhouse down'));
    await eventEngine.updateLeaderboard(DURING);
    expect(mockScoring.refreshStandings).toHaveBeenCalledTimes(1);
    // ...and the failure is reported, not swallowed.
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'event-points-referee',
        message: 'clickhouse down',
      })
    );
  });

  it('scores everyone from the start, base on or off', async () => {
    for (const isPublic of [true, false]) {
      testerFlag.reset({ public: isPublic });
      await eventEngine.updateLeaderboard(DURING);
    }
    expect(settled()).toEqual([
      { name: BIRTHDAY_2026_EVENT, season: 'live' },
      { name: BIRTHDAY_2026_EVENT, season: 'live' },
    ]);
    expect(standingsFrom()).toEqual([BIRTHDAY_2026_STARTS_AT, BIRTHDAY_2026_STARTS_AT]);
  });

  it('lets a tester join during the preview, and nobody else', async () => {
    testerFlag.reset({ public: false, testers: [7] });
    redisMock.sysRedis.hGetAll.mockResolvedValue({ '7': 'Blue', '8': 'Blue' });
    expect(await eventEngine.join(BIRTHDAY_2026_EVENT, { id: 7 }, PREVIEW)).toMatchObject({
      joined: true,
    });
    await expect(eventEngine.join(BIRTHDAY_2026_EVENT, { id: 8 }, PREVIEW)).rejects.toThrow(
      "That event doesn't exist"
    );
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('getEventData: what the scored-event page reads', () => {
  const live = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + HOUR);

  // The page names a winner only once this has passed; before it, late data can still reorder the
  // standings.
  it('says when the result is final: the end plus the scoring finalize window', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    const data = await eventEngine.getEventData(BIRTHDAY_2026_EVENT, { id: 7 }, live);
    expect(data.finalAt).toEqual(new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 24 * HOUR));
  });

  it("carries the birthday's hero art and accent headline", async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    const { page } = await eventEngine.getEventData(BIRTHDAY_2026_EVENT, { id: 7 }, live);
    expect(page).toMatchObject({
      headline: 'Civitai turns 4.',
      headlineAccent: 'Pick up a hat.',
      heroImage: '4a5e404d-ece2-4cca-bbab-cb5a7b0d8d9d',
      heroVideo: { id: 'ecd5aeef-b4d5-497d-bdd7-51750c302122', title: 'Hats On', duration: 42.411 },
      dates: 'Nov 1 to Nov 30',
    });
  });

  // Justin, 2026-10-09: the event runs for all of November, 2026-11-01 00:00 UTC through
  // 2026-11-30 23:59 UTC. ENDS_AT is exclusive, so it is the first instant of December, and every
  // date the page and banner state by hand has to say the same.
  it('runs for all of November in UTC, and says so on the page and the banner', () => {
    expect(BIRTHDAY_2026_STARTS_AT.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(BIRTHDAY_2026_ENDS_AT.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(birthday2026.page?.dates).toBe('Nov 1 to Nov 30');
    expect(birthday2026.banner?.text).toContain('Four colour teams, Nov 1 to Nov 30.');
  });
});
