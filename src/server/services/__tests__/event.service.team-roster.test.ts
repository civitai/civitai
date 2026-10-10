import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The roster read: gated by the event's access, team names checked against the event, and nothing
 * returned for an account that is gone. Which members are listed at all is roster.ts's job and is
 * tested there.
 */

const { engine, roster, caches, settings, sync } = vi.hoisted(() => ({
  engine: {
    getReadableScoredEvent: vi.fn(),
    isJoinEvent: vi.fn(),
    join: vi.fn(),
    queueAddRole: vi.fn(),
  },
  roster: { readRosterPage: vi.fn(), eventRosterKeys: vi.fn(() => ({ members: 'members' })) },
  caches: {
    userBasicCache: { fetch: vi.fn() },
    profilePictureCache: { fetch: vi.fn(async () => ({})) },
    cosmeticCache: { fetch: vi.fn() },
  },
  settings: { patchUserSettings: vi.fn(), getUserSettings: vi.fn() },
  sync: {
    syncRosterMembersWith: vi.fn(),
    rosterEvents: vi.fn(),
    defaultRosterSyncDeps: vi.fn(() => ({})),
    syncEventRosterMember: vi.fn(),
    ROSTER_SETTING: 'eventRosterOptIn',
    rosterTeam: (v: string | null) => (v && !v.startsWith('x:') ? v : null),
  },
}));
vi.mock('~/server/events', () => ({ eventEngine: engine }));
vi.mock('~/server/events/points/roster', () => roster);
vi.mock('~/server/events/points/roster-sync', () => sync);
vi.mock('~/server/redis/caches', () => ({
  ...caches,
  eventDecorationEntityCaches: {},
  publicContentCaches: {},
  refreshOwnedStickerCache: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({
  ...settings,
  cosmeticStatus: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticDetail: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ getEntityCoverImage: vi.fn() }));

const { redisMock } = await import('~/__tests__/mocks/redis.mock');
const { activateEventCosmetic, getMyRosterStatus, getTeamRoster, setRosterOptIn } = await import(
  '~/server/services/event.service'
);
const { seasonOwnerTopicId } = await import('~/server/events/points/keys');

const EVENT = {
  name: 'birthday2026',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  teams: ['Blue', 'Pink'],
  join: { claimKey: 'claimed', design: 'basic' },
};
const row = (userId: number) => ({
  userId,
  hats: [
    { id: 7, worn: true, price: 3000 },
    { id: 8, worn: false, price: null },
  ],
  hatCount: 2,
  points: 40,
  joinedAt: new Date('2026-10-20T00:00:00.000Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  engine.getReadableScoredEvent.mockResolvedValue(EVENT);
  roster.readRosterPage.mockResolvedValue({
    rows: [row(1), row(2)],
    total: 2,
    nextOffset: undefined,
  });
  caches.userBasicCache.fetch.mockResolvedValue({
    1: { id: 1, username: 'one', image: null, deletedAt: null },
    2: { id: 2, username: 'gone', image: null, deletedAt: new Date() },
  });
  caches.cosmeticCache.fetch.mockResolvedValue({
    7: { name: 'Crown - Blue', data: { url: 'crown.png', team: 'Blue' } },
    8: { name: 'Party Cap - Blue', data: { url: 'cap.png', team: 'Blue' } },
  });
});

const VIEWER = { id: 77 };
const read = (team = 'Blue', sort: 'hats' | 'points' | 'newest' = 'hats', cursor?: number) =>
  getTeamRoster({ event: EVENT.name, team, sort, cursor, limit: 24, viewer: VIEWER });

describe('getTeamRoster', () => {
  it('reads through the event gate, for the viewer', async () => {
    engine.getReadableScoredEvent.mockRejectedValue(new Error("That event doesn't exist"));
    await expect(read()).rejects.toThrow("That event doesn't exist");
    expect(engine.getReadableScoredEvent).toHaveBeenCalledWith(EVENT.name, VIEWER);
    expect(roster.readRosterPage).not.toHaveBeenCalled();
  });

  it('refuses a team the event does not have', async () => {
    await expect(read('Orange')).rejects.toThrow('That team does not exist');
    expect(roster.readRosterPage).not.toHaveBeenCalled();
  });

  it("reads the asked page in the season of now, and passes the store's paging through", async () => {
    vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00.000Z') });
    try {
      roster.readRosterPage.mockResolvedValue({ rows: [row(1)], total: 30, nextOffset: 48 });
      const result = await read('Pink', 'points', 24);
      expect(roster.readRosterPage).toHaveBeenCalledWith({
        event: EVENT.name,
        team: 'Pink',
        sort: 'points',
        season: 'preview',
        offset: 24,
        limit: 24,
      });
      expect(result.total).toBe(30);
      expect(result.nextCursor).toBe(48);
      // The card's topic is this member's, in this season.
      expect(result.items[0].topicId).toBe(seasonOwnerTopicId(EVENT.name, 1, 'preview'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a deleted account and returns each hat with whether it is worn and its price', async () => {
    const result = await read();
    expect(result.items.map((i) => i.user.username)).toEqual(['one']);
    expect(result.items[0].hats).toEqual([
      { cosmeticId: 7, name: 'Crown', url: 'crown.png', worn: true, price: 3000 },
      { cosmeticId: 8, name: 'Party Cap', url: 'cap.png', worn: false, price: null },
    ]);
  });
});

describe('setRosterOptIn', () => {
  it('writes the setting under the event before it syncs the member', async () => {
    sync.rosterEvents.mockResolvedValue([EVENT]);
    redisMock.sysRedis.hGet.mockResolvedValue('Blue');
    const result = await setRosterOptIn({ event: EVENT.name, optIn: true, user: { id: 5 } });
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventRosterOptIn: { birthday2026: true } },
      location: 'event.service:setRosterOptIn',
    });
    expect(sync.syncRosterMembersWith).toHaveBeenCalledWith(EVENT, [5], {});
    // The sync reads the setting back from Postgres: written after it, it would list nobody.
    expect(settings.patchUserSettings.mock.invocationCallOrder[0]).toBeLessThan(
      sync.syncRosterMembersWith.mock.invocationCallOrder[0]
    );
    expect(result).toEqual({ optedIn: true, listedTeam: 'Blue' });
  });

  it('writes an opt-out as false, and only changes the setting before the preview', async () => {
    sync.rosterEvents.mockResolvedValue([]);
    redisMock.sysRedis.hGet.mockResolvedValue(null);
    await setRosterOptIn({ event: EVENT.name, optIn: false, user: { id: 5 } });
    expect(settings.patchUserSettings).toHaveBeenCalledWith(5, {
      mergeInto: { eventRosterOptIn: { birthday2026: false } },
      location: 'event.service:setRosterOptIn',
    });
    expect(sync.syncRosterMembersWith).not.toHaveBeenCalled();
  });

  it('reports a tombstone as not listed', async () => {
    sync.rosterEvents.mockResolvedValue([EVENT]);
    redisMock.sysRedis.hGet.mockResolvedValue('x:123');
    const result = await setRosterOptIn({ event: EVENT.name, optIn: false, user: { id: 5 } });
    expect(result).toEqual({ optedIn: false, listedTeam: null });
  });
});

describe('getMyRosterStatus', () => {
  it("reads the caller's own setting for this event and their gate entry", async () => {
    settings.getUserSettings.mockResolvedValue({
      eventRosterOptIn: { birthday2026: true, other: false },
    });
    redisMock.sysRedis.hGet.mockResolvedValue('Pink');
    expect(await getMyRosterStatus({ event: EVENT.name, user: { id: 9 } })).toEqual({
      optedIn: true,
      listedTeam: 'Pink',
    });
    expect(settings.getUserSettings).toHaveBeenCalledWith(9);
    expect(redisMock.sysRedis.hGet).toHaveBeenCalledWith('members', '9');
    expect(engine.getReadableScoredEvent).toHaveBeenCalledWith(EVENT.name, { id: 9 });
  });

  it('reads another event, or no setting, as not opted in', async () => {
    settings.getUserSettings.mockResolvedValue({ eventRosterOptIn: { other: true } });
    redisMock.sysRedis.hGet.mockResolvedValue(null);
    expect(await getMyRosterStatus({ event: EVENT.name, user: { id: 9 } })).toEqual({
      optedIn: false,
      listedTeam: null,
    });
  });
});

// Someone who opted in before joining is listed by the join itself: the reconcile only visits
// members already listed, so without this they would never appear.
describe('activateEventCosmetic', () => {
  it('syncs the member on a real join, and not on a repeat', async () => {
    engine.isJoinEvent.mockReturnValue(true);
    engine.join.mockResolvedValue({ cosmeticId: 1, team: 'Blue', joined: true });
    await activateEventCosmetic({ event: EVENT.name, user: { id: 5 } });
    expect(sync.syncEventRosterMember).toHaveBeenCalledWith(5, { event: EVENT.name });
    sync.syncEventRosterMember.mockClear();
    engine.join.mockResolvedValue({ cosmeticId: 1, team: 'Blue', joined: false });
    await activateEventCosmetic({ event: EVENT.name, user: { id: 5 } });
    expect(sync.syncEventRosterMember).not.toHaveBeenCalled();
  });
});
