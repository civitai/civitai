import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DecorationConstants from '~/shared/constants/event-decoration.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { encodeHat, eventPointKeys, hatTopicId, previewTopicId } from '~/server/events/points/keys';
import type { EventHat } from '~/server/events/points/types';

/**
 * The service layer is where the scored-event routes meet the engine. These pin that every scored
 * read goes through the engine's access gate for the viewer, and that the join branch only
 * side-effects on a real join.
 */

const { engine, scoring } = vi.hoisted(() => ({
  engine: {
    getJoinHats: vi.fn(async () => []),
    getReadableScoredEvent: vi.fn(),
    assertReadable: vi.fn(),
    isJoinEvent: vi.fn(),
    getJoinDesign: vi.fn(() => 'basic'),
    join: vi.fn(),
    queueAddRole: vi.fn(),
    getUserData: vi.fn(),
    getTeamScores: vi.fn(),
    getTeamScoreHistory: vi.fn(),
    getPartners: vi.fn(),
    getRewards: vi.fn(),
    getTopContributors: vi.fn(),
  },
  scoring: {
    getEventStandings: vi.fn(),
    getUserCosmeticScores: vi.fn(),
    getCosmeticScores: vi.fn(),
  },
}));

// The decoration on the content and whether the content is public, both cached.
const caches = vi.hoisted(() => ({ worn: { fetch: vi.fn() }, visible: { fetch: vi.fn() } }));

// Live totals from the points engine. Default: up, with nothing earned yet.
const live = vi.hoisted(() => ({
  getHatPoints: vi.fn(),
  getTeamPoints: vi.fn(),
}));
vi.mock('~/server/events/points/read', () => live);

vi.mock('~/server/events', () => ({ eventEngine: engine }));
// The real cosmeticScoreKey: the service joins scores to hats with it.
vi.mock('~/server/events/scoring/cosmetic-placement.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...scoring,
}));
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { fetch: vi.fn(async () => ({ 21: { name: 'Party Cap - Yellow' } })) },
  eventDecorationEntityCaches: new Proxy({}, { get: () => caches.worn }),
  publicContentCaches: { Image: caches.visible, Model: caches.visible, Article: caches.visible },
  profilePictureCache: { fetch: vi.fn(async () => ({})) },
  refreshOwnedStickerCache: vi.fn(),
  userBasicCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticDetail: vi.fn(async ({ id }: { id: number }) => ({ id })),
}));
const { covers, decorations } = vi.hoisted(() => ({
  covers: vi.fn(),
  decorations: {
    getEventDecorationDefinition: vi.fn(),
    real: (() => undefined) as (event: string) => unknown,
  },
}));
vi.mock('~/shared/constants/event-decoration.constants', async (importOriginal) => {
  const actual = await importOriginal<typeof DecorationConstants>();
  decorations.real = actual.getEventDecorationDefinition;
  decorations.getEventDecorationDefinition.mockImplementation(actual.getEventDecorationDefinition);
  return { ...actual, getEventDecorationDefinition: decorations.getEventDecorationDefinition };
});
vi.mock('~/server/services/image.service', () => ({ getEntityCoverImage: covers }));
vi.mock('~/server/services/user.service', () => ({
  cosmeticStatus: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
}));

const service = await import('~/server/services/event.service');

const notStarted = () => {
  throw new Error("That event doesn't exist");
};
const scored = {
  name: 'birthday2026',
  teams: ['Yellow', 'Blue'],
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: new Date('2999-01-01T00:00:00Z'),
  // A previewer's reads start here; the live totals are keyed by the real startDate regardless.
  scoreFrom: new Date('2026-10-20T00:00:00Z'),
};
const season = { name: 'birthday2026', startDate: scored.startDate };
// Topic ids follow the season of the read's own clock: the public id once the event has started,
// a keyed one in the preview (points/keys.ts).
const LIVE_NOW = '2026-11-02T00:00:00Z';
const PREVIEW_NOW = '2026-10-25T00:00:00Z';
const at = (now: string) => vi.useFakeTimers({ now: new Date(now), toFake: ['Date'] });
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  engine.getReadableScoredEvent.mockResolvedValue(scored);
  scoring.getEventStandings.mockResolvedValue({ teams: [], topCosmetics: [], topUsers: {} });
  scoring.getUserCosmeticScores.mockResolvedValue([]);
  scoring.getCosmeticScores.mockResolvedValue({});
  live.getHatPoints.mockResolvedValue({});
  live.getTeamPoints.mockResolvedValue({});
  caches.worn.fetch.mockResolvedValue({});
  caches.visible.fetch.mockResolvedValue({});
  covers.mockResolvedValue([]);
  engine.assertReadable.mockReset();
  decorations.getEventDecorationDefinition.mockImplementation(decorations.real);
});

describe('scored reads are gated on what the viewer may read', () => {
  const viewer = { id: 1, isModerator: false };
  const reads = {
    getEventStandings: () => service.getEventStandings({ event: 'birthday2026', viewer }),
    getMyEventCosmeticScores: () =>
      service.getMyEventCosmeticScores({ event: 'birthday2026', user: viewer }),
    getEventCosmeticScores: () =>
      service.getEventCosmeticScores({ event: 'birthday2026', cosmetics: [], viewer }),
    getWornEventHat: () =>
      service.getWornEventHat({ event: 'birthday2026', entityType: 'Image', entityId: 5, viewer }),
  };

  for (const [name, read] of Object.entries(reads)) {
    it(`${name} refuses when the viewer may not read it, and reads nothing`, async () => {
      engine.getReadableScoredEvent.mockImplementation(notStarted);
      await expect(read()).rejects.toThrow("That event doesn't exist");
      expect(scoring.getEventStandings).not.toHaveBeenCalled();
      expect(scoring.getUserCosmeticScores).not.toHaveBeenCalled();
      expect(scoring.getCosmeticScores).not.toHaveBeenCalled();
    });

    it(`${name} reads for that viewer`, async () => {
      await read();
      expect(engine.getReadableScoredEvent).toHaveBeenCalledWith('birthday2026', viewer);
    });
  }

  it('getMyEventCosmeticScores sums points and names each cosmetic', async () => {
    scoring.getUserCosmeticScores.mockResolvedValue([
      { cosmeticId: 21, claimKey: 'claimed', points: 20 },
      { cosmeticId: 21, claimKey: 'txn-1', points: 4 },
    ]);
    const res = await service.getMyEventCosmeticScores({
      event: 'birthday2026',
      user: { id: 1 },
    });
    expect(res.points).toBe(24);
    expect(res.cosmetics.map((c) => c.name)).toEqual(['Party Cap - Yellow', 'Party Cap - Yellow']);
  });

  it('getEventCosmetic refuses an unreadable event without touching the cache', async () => {
    engine.assertReadable.mockImplementation(notStarted);
    await expect(
      service.getEventCosmetic({ event: 'birthday2026', user: { id: 1 } })
    ).rejects.toThrow("That event doesn't exist");
    expect(redisMock.redis.packed.hGet).not.toHaveBeenCalled();
  });
});

describe('activateEventCosmetic on a join event', () => {
  beforeEach(() => engine.isJoinEvent.mockReturnValue(true));

  it('clears the status cache and queues the team role on a real join', async () => {
    engine.join.mockResolvedValue({ team: 'Blue', cosmeticId: 22, joined: true });
    const res = await service.activateEventCosmetic({ event: 'birthday2026', user: { id: 7 } });

    expect(res).toEqual({ cosmetic: { id: 22 } });
    expect(redisMock.redis.hDel).toHaveBeenCalledTimes(1);
    expect(engine.queueAddRole).toHaveBeenCalledWith({
      event: 'birthday2026',
      team: 'Blue',
      userId: 7,
    });
    expect(engine.getUserData).not.toHaveBeenCalled(); // never falls through to the bank-event path
  });

  it('does neither on a repeat join', async () => {
    engine.join.mockResolvedValue({ team: 'Blue', cosmeticId: 22, joined: false });
    const res = await service.activateEventCosmetic({ event: 'birthday2026', user: { id: 7 } });

    expect(res).toEqual({ cosmetic: { id: 22 } }); // the held cosmetic, passed through

    expect(redisMock.redis.hDel).not.toHaveBeenCalled();
    expect(engine.queueAddRole).not.toHaveBeenCalled();
  });
});

// Every event read refuses an event the viewer cannot see before touching anything, and passes the
// viewer's access on so a previewer reads the preview's scores.
describe('the other event reads are gated on the viewer too', () => {
  const viewer = { id: 3, isModerator: false };
  const reads = {
    getTeamScores: [
      () => service.getTeamScores({ event: 'birthday2026', viewer }),
      engine.getTeamScores,
    ],
    getTeamScoreHistory: [
      () => service.getTeamScoreHistory({ event: 'birthday2026', viewer }),
      engine.getTeamScoreHistory,
    ],
    getEventPartners: [
      () => service.getEventPartners({ event: 'birthday2026', viewer }),
      engine.getPartners,
    ],
    getEventRewards: [
      () => service.getEventRewards({ event: 'birthday2026', viewer }),
      engine.getRewards,
    ],
    getEventContributors: [
      () => service.getEventContributors({ event: 'birthday2026', viewer }),
      engine.getTopContributors,
    ],
    getUserRank: [
      () => service.getUserRank({ event: 'birthday2026', user: viewer }),
      engine.getUserData,
    ],
  } as const;

  for (const [name, [read, downstream]] of Object.entries(reads)) {
    // Control for the refusal below: the same read goes through for a viewer who may read it.
    it(`${name} reads for a viewer who may`, async () => {
      engine.assertReadable.mockReset().mockResolvedValue('open');
      engine.getTopContributors.mockResolvedValue({ allTime: [], day: [], teams: {} });
      engine.getUserData.mockResolvedValue({ team: 'Blue' });
      await read();
      expect(downstream).toHaveBeenCalledTimes(1);
    });

    it(`${name} refuses when the viewer may not read it, and reads nothing`, async () => {
      engine.assertReadable.mockImplementation(notStarted);
      await expect(read()).rejects.toThrow("That event doesn't exist");
      expect(engine.assertReadable).toHaveBeenCalledWith('birthday2026', viewer);
      expect(downstream).not.toHaveBeenCalled();
    });
  }

  it('reads team scores and history as the window the viewer is in', async () => {
    engine.assertReadable.mockResolvedValue('preview');
    // Both routes are edge-cached: a read that fell back to zeros must be able to say so.
    const onDegraded = vi.fn();
    await service.getTeamScores({ event: 'birthday2026', viewer, onDegraded });
    await service.getTeamScoreHistory({ event: 'birthday2026', viewer, onDegraded });
    expect(engine.getTeamScores).toHaveBeenCalledWith('birthday2026', 'preview', { onDegraded });
    expect(engine.getTeamScoreHistory).toHaveBeenCalledWith({ event: 'birthday2026' }, 'preview', {
      onDegraded,
    });
  });
});

describe('getMyEventHats', () => {
  const user = { id: 9 };
  const placedAt = '2026-11-12T10:00:00.000Z';
  const hatData = { type: 'hat', event: 'birthday2026', team: 'Pink', url: 'u' };

  beforeEach(() => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      {
        cosmeticId: 31,
        claimKey: 'claimed',
        name: 'Party Cap',
        data: hatData,
        equippedToType: 'Image',
        equippedToId: 500,
        placedAt,
      },
      {
        cosmeticId: 32,
        claimKey: 'txn-9',
        name: 'Crown',
        data: hatData,
        equippedToType: null,
        equippedToId: null,
        placedAt: null,
      },
    ]);
    scoring.getCosmeticScores.mockResolvedValue({
      '9:31:claimed': {
        points: 140,
        impressions: 90,
        anonImpressions: 10,
        reactions: 4,
        comments: 3,
        stickers: 2,
        remixes: 1,
      },
    });
    live.getHatPoints.mockResolvedValue({ '9:31:claimed': 175 });
    covers.mockResolvedValue([{ entityType: 'Image', entityId: 500, id: 77, url: 'img' }]);
  });

  it('refuses an event the caller may not read, and reads nothing', async () => {
    engine.getReadableScoredEvent.mockImplementation(notStarted);
    await expect(service.getMyEventHats({ event: 'birthday2026', user })).rejects.toThrow(
      "That event doesn't exist"
    );
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  // An unplaced hat has no score row; reading hats from the scores would drop it, and a hat you
  // just bought would not appear until it had earned something.
  it('lists every owned hat, placed or not, with its score and where it is', async () => {
    at(LIVE_NOW);
    const hats = await service.getMyEventHats({ event: 'birthday2026', user });
    expect(hats.map((h) => [h.cosmeticId, h.claimKey])).toEqual([
      [31, 'claimed'],
      [32, 'txn-9'],
    ]);
    expect(hats[0]).toMatchObject({
      points: 175,
      impressions: 100,
      reactions: 4,
      comments: 3,
      stickers: 2,
      remixes: 1,
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'claimed' }),
      placedOn: { entityType: 'Image', entityId: 500, image: { id: 77 } },
    });
    expect(hats[1]).toMatchObject({ points: 0, comments: 0, placedOn: null, movableAt: null });
  });

  // Only a caller the preview lets in reaches this read before the start, so only they learn these.
  it('in the preview, gives each hat its keyed id: unlike its live id, the same on every read', async () => {
    at(PREVIEW_NOW);
    const first = await service.getMyEventHats({ event: 'birthday2026', user });
    const again = await service.getMyEventHats({ event: 'birthday2026', user });
    const keyed = [
      previewTopicId('birthday2026', '9:31:claimed'),
      previewTopicId('birthday2026', '9:32:txn-9'),
    ];
    expect(first.map((h) => h.topicId)).toEqual(keyed);
    // Read as the caller, so the gate decides on them: a tester gets past it, nobody else does.
    expect(engine.getReadableScoredEvent).toHaveBeenCalledWith('birthday2026', user);
    expect(again.map((h) => h.topicId)).toEqual(keyed);
    expect(keyed[0]).not.toBe(hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'claimed' }));
  });

  // A live read that answers is the total, even where it has nothing: the snapshot is only for when
  // the live store is unreachable.
  it('reads a hat missing from an answering live read as 0, not its snapshot', async () => {
    live.getHatPoints.mockResolvedValue({});
    const [placed] = await service.getMyEventHats({ event: 'birthday2026', user });
    expect(placed.points).toBe(0);
  });

  // Points are the live total; the per-type counts are the hourly snapshot's.
  it("reads points live for every hat, keyed by the event's real start", async () => {
    await service.getMyEventHats({ event: 'birthday2026', user });
    expect(live.getHatPoints).toHaveBeenCalledWith(season, [
      { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' },
      { ownerId: 9, cosmeticId: 32, claimKey: 'txn-9' },
    ]);
  });

  it('falls back to the snapshot when the live totals are unreachable', async () => {
    live.getHatPoints.mockRejectedValue(new Error('sysredis down'));
    const [placed] = await service.getMyEventHats({ event: 'birthday2026', user });
    expect(placed.points).toBe(140);
  });

  it('says when a placed hat may move again, from the event decoration cooldown', async () => {
    const [placed] = await service.getMyEventHats({ event: 'birthday2026', user });
    expect(placed.movableAt).toEqual(new Date(Date.parse(placedAt) + 10 * 60 * 1000));
  });

  // The page counts down from this rather than comparing movableAt to the browser's clock, so it is
  // measured on the server's clock and never longer than the cooldown.
  describe('moveCooldownLeftMs', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    it.each([
      ['3 minutes after placing', '2026-11-12T10:03:00.000Z', 7 * 60 * 1000],
      ['once the cooldown is over', '2026-11-12T10:15:00.000Z', 0],
      ['when placedAt is ahead of this server', '2026-11-12T09:58:00.000Z', 10 * 60 * 1000],
    ])('%s', async (_label, now, left) => {
      vi.useFakeTimers({ now: new Date(now), toFake: ['Date'] });
      const [placed, unplaced] = await service.getMyEventHats({ event: 'birthday2026', user });
      expect(placed.moveCooldownLeftMs).toBe(left);
      expect(unplaced.moveCooldownLeftMs).toBe(0);
    });
  });

  // The rows are the mock's, so pin what the query asks for: this caller, this event's decorations.
  it("queries only this caller's decorations of this event", async () => {
    await service.getMyEventHats({ event: 'birthday2026', user });
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain(`WHERE uc."userId" = ?\n`);
    expect(sql).toContain(`AND c.type = 'ContentDecoration'\n`);
    expect(sql).toContain(`AND c.data->>'event' = ?\n`);
    expect(values).toEqual([9, 'birthday2026']);
  });

  it("asks for the scores of exactly the caller's hats", async () => {
    await service.getMyEventHats({ event: 'birthday2026', user });
    expect(scoring.getCosmeticScores).toHaveBeenCalledWith(scored, [
      { userId: 9, cosmeticId: 31, claimKey: 'claimed' },
      { userId: 9, cosmeticId: 32, claimKey: 'txn-9' },
    ]);
  });
});

describe('getPlaceableEventContent', () => {
  const user = { id: 9 };
  // Braced: a function returned from beforeEach runs as teardown, and the mock is one.
  beforeEach(() => {
    engine.assertReadable.mockReset().mockResolvedValue('open');
  });

  it('refuses an event the caller may not read, and reads nothing', async () => {
    engine.assertReadable.mockImplementation(notStarted);
    await expect(service.getPlaceableEventContent({ event: 'birthday2026', user })).rejects.toThrow(
      "That event doesn't exist"
    );
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });

  // Exactly what may wear a hat: the caller's own, published, scanned content. Equipping does not
  // check publish state, so this list is the only place a draft is kept out.
  it("reads only the caller's own published content", async () => {
    await service.getPlaceableEventContent({ event: 'birthday2026', user });
    expect(dbMock.dbRead.image.findMany.mock.calls[0][0].where).toEqual({
      userId: 9,
      ingestion: 'Scanned',
      post: { publishedAt: { not: null } },
    });
    expect(dbMock.dbRead.model.findMany.mock.calls[0][0].where).toEqual({
      userId: 9,
      status: 'Published',
    });
    expect(dbMock.dbRead.article.findMany.mock.calls[0][0].where).toEqual({
      userId: 9,
      status: 'Published',
    });
  });

  it('reads only the content types the event decoration can be worn on', async () => {
    decorations.getEventDecorationDefinition.mockReturnValueOnce({
      ...decorations.real('birthday2026'),
      entityTypes: ['Image'],
    });
    await service.getPlaceableEventContent({ event: 'birthday2026', user });
    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.article.findMany).not.toHaveBeenCalled();
  });

  it('names each entity and keeps one with no usable cover', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValueOnce([{ id: 1 }]);
    dbMock.dbRead.model.findMany
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 2, name: 'Velvet LoRA' }]);
    dbMock.dbRead.article.findMany
      .mockResolvedValueOnce([{ id: 3 }])
      .mockResolvedValueOnce([{ id: 3, title: 'Lighting notes' }]);
    covers.mockResolvedValue([
      { entityType: 'Image', entityId: 1, id: 101 },
      { entityType: 'Article', entityId: 3, id: 103 },
    ]);
    const content = await service.getPlaceableEventContent({ event: 'birthday2026', user });
    expect(content.map((c) => [c.entityType, c.entityId, c.title, c.image?.id ?? null])).toEqual([
      ['Image', 1, null, 101],
      ['Model', 2, 'Velvet LoRA', null],
      ['Article', 3, 'Lighting notes', 103],
    ]);
  });
});

describe('getEventStandings decoration', () => {
  const viewer = { id: 1 };

  it("returns each team's join hat art", async () => {
    engine.getJoinHats.mockResolvedValueOnce([{ team: 'Yellow', url: 'cap-y' }]);
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    expect(res.teamHats).toEqual([{ team: 'Yellow', url: 'cap-y' }]);
  });

  it('takes team totals live and re-ranks; history and top lists stay on the snapshot', async () => {
    const history = [{ team: 'Yellow', scores: [] }];
    scoring.getEventStandings.mockResolvedValue({
      teams: [
        { team: 'Yellow', score: 900, rank: 1 },
        { team: 'Blue', score: 800, rank: 2 },
      ],
      history,
      topCosmetics: [],
      topUsers: {},
    });
    live.getTeamPoints.mockResolvedValue({ Yellow: 950, Blue: 1000 });
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    expect(res.teams).toEqual([
      { team: 'Blue', score: 1000, rank: 1 },
      { team: 'Yellow', score: 950, rank: 2 },
    ]);
    expect(res.history).toBe(history);
    expect(live.getTeamPoints).toHaveBeenCalledWith({ ...season, teams: scored.teams });
  });

  // After the end the page names a winner: it must be the settled one the prize payout reads.
  it('shows the settled team totals once the event has ended, never live ones', async () => {
    const teams = [
      { team: 'Yellow', score: 900, rank: 1 },
      { team: 'Blue', score: 800, rank: 2 },
    ];
    engine.getReadableScoredEvent.mockResolvedValue({
      ...scored,
      endDate: new Date(Date.now() - 1000),
    });
    scoring.getEventStandings.mockResolvedValue({ teams, topCosmetics: [], topUsers: {} });
    live.getTeamPoints.mockResolvedValue({ Yellow: 950, Blue: 1000 });
    const onDegraded = vi.fn();
    const res = await service.getEventStandings({ event: 'birthday2026', viewer, onDegraded });
    expect(res.teams).toEqual(teams);
    expect(live.getTeamPoints).not.toHaveBeenCalled();
    // Settled by design, not a fallback: the answer stays edge-cacheable.
    expect(onDegraded).not.toHaveBeenCalled();
  });

  it('hands the hat scores read the degraded callback', async () => {
    const onDegraded = vi.fn();
    const cosmetics = [{ userId: 9, cosmeticId: 31, claimKey: 'claimed' }];
    await service.getEventCosmeticScores({ event: 'birthday2026', cosmetics, viewer, onDegraded });
    expect(scoring.getCosmeticScores).toHaveBeenCalledWith(scored, cosmetics, onDegraded);
  });

  // The settled snapshot is on sysRedis too: an unreachable one must not be edge-cached as zeros.
  it('hands the settled read the same degraded callback', async () => {
    const onDegraded = vi.fn();
    await service.getEventStandings({ event: 'birthday2026', viewer, onDegraded });
    expect(scoring.getEventStandings).toHaveBeenCalledWith(scored, { onDegraded });
  });

  it('keeps the snapshot team totals when the live totals are unreachable', async () => {
    const teams = [{ team: 'Yellow', score: 900, rank: 1 }];
    scoring.getEventStandings.mockResolvedValue({ teams, topCosmetics: [], topUsers: {} });
    live.getTeamPoints.mockRejectedValue(new Error('sysredis down'));
    const onDegraded = vi.fn();
    const res = await service.getEventStandings({ event: 'birthday2026', viewer, onDegraded });
    expect(res.teams).toEqual(teams);
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  // The biggest-hats rows draw their owner with UserAvatar, which reads both of these.
  it("gives each top hat's owner their profile picture and cosmetics", async () => {
    const { userBasicCache, profilePictureCache } = await import('~/server/redis/caches');
    const { getCosmeticsForUsers } = await import('~/server/services/user.service');
    scoring.getEventStandings.mockResolvedValueOnce({
      teams: [],
      topCosmetics: [{ userId: 7, cosmeticId: 21, claimKey: 'a', team: 'Yellow', points: 5 }],
      topUsers: {},
    });
    const queued = [profilePictureCache.fetch, getCosmeticsForUsers].map((fn) => vi.mocked(fn));
    const defaults = queued.map((fn) => fn.getMockImplementation());
    vi.mocked(userBasicCache.fetch).mockResolvedValueOnce({ 7: { id: 7, username: 'hatter' } });
    vi.mocked(profilePictureCache.fetch).mockResolvedValueOnce({ 7: { id: 70, url: 'pfp' } });
    vi.mocked(getCosmeticsForUsers).mockResolvedValueOnce({ 7: [{ cosmeticId: 5 }] });

    try {
      const res = await service.getEventStandings({ event: 'birthday2026', viewer });

      expect(profilePictureCache.fetch).toHaveBeenCalledWith([7]);
      expect(getCosmeticsForUsers).toHaveBeenCalledWith([7]);
      expect(res.users[7]).toEqual({
        id: 7,
        username: 'hatter',
        profilePicture: { id: 70, url: 'pfp' },
        cosmetics: [{ cosmeticId: 5 }],
      });
    } finally {
      // clearAllMocks keeps once-queues: if the service stops calling these, the unused values
      // would otherwise answer the contributor tests below and redden them for the wrong reason.
      queued.forEach((fn, i) => {
        fn.mockReset();
        const impl = defaults[i];
        if (impl) fn.mockImplementation(impl);
      });
    }
  });

  // Public and edge-cached, and a bought hat's claim key is its purchase's transaction id.
  it('sends each top hat under its opaque topic id, never its claim key', async () => {
    at(LIVE_NOW);
    const hat = { userId: 7, cosmeticId: 21, team: 'Yellow', points: 5 };
    const claimKey = 'cosmetic-purchase-txn-9';
    scoring.getEventStandings.mockResolvedValueOnce({
      teams: [],
      topCosmetics: [{ ...hat, claimKey }],
      topUsers: {},
    });
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    expect(JSON.stringify(res)).not.toContain(claimKey);
    expect(res.topCosmetics).toStrictEqual([
      { ...hat, topicId: hatTopicId({ ownerId: 7, cosmeticId: 21, claimKey }) },
    ]);
    expect(res.teamsTopicId).toBe('teams');
  });

  it('in the preview, names the top hats and the team totals by their keyed ids', async () => {
    at(PREVIEW_NOW);
    const hat = { userId: 7, cosmeticId: 21, team: 'Yellow', points: 5 };
    const claimKey = 'cosmetic-purchase-txn-9';
    scoring.getEventStandings.mockResolvedValue({
      teams: [],
      topCosmetics: [{ ...hat, claimKey }],
      topUsers: {},
    });
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    const again = await service.getEventStandings({ event: 'birthday2026', viewer });
    const keyed = previewTopicId('birthday2026', `7:21:${claimKey}`);
    expect(res.topCosmetics).toStrictEqual([{ ...hat, topicId: keyed }]);
    expect(res.teamsTopicId).toBe(previewTopicId('birthday2026', 'teams'));
    expect(again.topCosmetics[0].topicId).toBe(keyed);
    expect(again.teamsTopicId).toBe(res.teamsTopicId);
    // The key never goes out with the ids it makes.
    const { env } = await import('~/env/server');
    expect(env.NEXTAUTH_SECRET.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain(env.NEXTAUTH_SECRET);
    expect(JSON.stringify(res)).not.toContain(claimKey);
  });

  // The art is decoration: a failed lookup must cost the hats, never the standings.
  it('still answers when the join hat lookup fails', async () => {
    engine.getJoinHats.mockRejectedValueOnce(new Error('redis down'));
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    expect(res.teamHats).toEqual([]);
    expect(res.teams).toEqual([]);
  });
});

describe('getEventHatCatalog', () => {
  const row = (design: string | null, team: string | null, url: string | null) => ({
    design,
    team,
    name: `${design} Cap - ${team}`,
    url,
  });

  it('refuses an event the caller may not read, and reads nothing', async () => {
    engine.assertReadable.mockImplementation(notStarted);
    await expect(
      service.getEventHatCatalog({ event: 'birthday2026', viewer: undefined })
    ).rejects.toThrow("That event doesn't exist");
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('groups the hats by design in catalogue order, named without the team', async () => {
    engine.assertReadable.mockResolvedValue('open');
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        row('bolt', 'Yellow', 'y1'),
        row('crown', 'Yellow', 'y2'),
        row('bolt', 'Blue', 'b1'),
        row(null, 'Blue', 'x'),
        row('crown', 'Blue', null),
        row('crown', null, 'z'),
        { design: 'plain', team: 'Green', name: 'Plain Hat', url: 'g3' },
      ]);
    const designs = await service.getEventHatCatalog({ event: 'birthday2026', viewer: undefined });
    expect(designs).toEqual([
      {
        design: 'bolt',
        name: 'bolt Cap',
        hats: [
          { team: 'Yellow', url: 'y1' },
          { team: 'Blue', url: 'b1' },
        ],
      },
      { design: 'crown', name: 'crown Cap', hats: [{ team: 'Yellow', url: 'y2' }] },
      { design: 'plain', name: 'Plain Hat', hats: [{ team: 'Green', url: 'g3' }] },
    ]);
  });

  // The rows are the mock's, so pin both whole queries: what is on sale now by the shop's own rule
  // (it is edge-cached for anonymous visitors), then this event's join design and those, in id order.
  it("queries only this event's join design and on-sale decorations, in id order", async () => {
    engine.assertReadable.mockResolvedValue('open');
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: 7 }, { id: 9 }]).mockResolvedValueOnce([]);
    await service.getEventHatCatalog({ event: 'birthday2026', viewer: undefined });
    const calls = dbMock.dbRead.$queryRaw.mock.calls as [string[], ...unknown[]][];
    const sql = (strings: string[]) => strings.join('?').replace(/\s+/g, ' ').trim();
    expect(calls).toHaveLength(2);
    const [[onSale, ...onSaleValues], [catalog, ...values]] = calls;
    expect(sql(onSale)).toBe(
      `SELECT DISTINCT si."cosmeticId" AS id FROM "CosmeticShopItem" si ` +
        `WHERE si."cosmeticId" IS NOT NULL AND si.status = 'Published' AND si.listed ` +
        `AND si."archivedAt" IS NULL ` +
        `AND (si."availableFrom" IS NULL OR si."availableFrom" <= now()) ` +
        `AND (si."availableTo" IS NULL OR si."availableTo" >= now()) ` +
        `AND EXISTS ( SELECT 1 FROM "CosmeticShopSectionItem" ssi ` +
        `JOIN "CosmeticShopSection" ss ON ss.id = ssi."shopSectionId" ` +
        `WHERE ssi."shopItemId" = si.id AND ss.published )`
    );
    expect(onSaleValues).toEqual([]);
    expect(sql(catalog)).toBe(
      `SELECT c.data->>'design' AS design, c.data->>'team' AS team, c.name, c.data->>'url' AS url ` +
        `FROM "Cosmetic" c WHERE c.type = 'ContentDecoration' AND c.data->>'event' = ? ` +
        `AND c."createdById" IS NULL ` +
        `AND (c.data->>'design' = ? OR c.id = ANY(?::int[])) ORDER BY c.id`
    );
    expect(values).toEqual(['birthday2026', 'basic', [7, 9]]);
  });
});

describe('getWornEventHat', () => {
  const viewer = { id: 1 };
  const read = (onDegraded?: () => void) =>
    service.getWornEventHat({
      event: 'birthday2026',
      entityType: 'Image',
      entityId: 5,
      viewer,
      onDegraded,
    });
  const decoration = {
    id: 31,
    name: 'Party Cap - Blue',
    type: 'ContentDecoration',
    source: 'Purchase',
    data: { type: 'hat', event: 'birthday2026', url: 'blue.png', team: 'Blue' },
    equippedToId: 5,
    equippedToType: 'Image',
    userId: 9,
  };
  const wearing = (worn: Record<string, unknown> = decoration) =>
    caches.worn.fetch.mockResolvedValue({ 5: worn });
  const inHatMap = (claimKey: string, hat: Partial<EventHat> = {}) =>
    redisMock.sysRedis.hGet.mockImplementation(async (key: string, field: string) =>
      key === eventPointKeys('birthday2026').hats && field === 'Image:5'
        ? encodeHat({ ownerId: 9, cosmeticId: 31, claimKey, team: 'Blue', ...hat })
        : null
    );
  const settled = (claimKey: string, points: number, extra: Record<string, number> = {}) => ({
    userId: 9,
    cosmeticId: 31,
    claimKey,
    team: 'Blue',
    points,
    impressions: 0,
    anonImpressions: 0,
    reactions: 0,
    comments: 0,
    stickers: 0,
    remixes: 0,
    modelLikes: 0,
    ...extra,
  });
  const userBasic = async () =>
    vi.mocked((await import('~/server/redis/caches')).userBasicCache.fetch);
  const profilePictures = async () =>
    vi.mocked((await import('~/server/redis/caches')).profilePictureCache.fetch);

  // Every case runs with Postgres throwing, and ends by asserting none of it was called (the live and
  // degraded fallbacks catch, so a throw alone could be swallowed): the only proof the popover never
  // reads it. Reset after, so the refusal does not leak into later blocks.
  let forbidden: ReturnType<typeof vi.fn>[] = [];
  beforeEach(() => {
    const refuse = (async () => {
      throw new Error('Postgres on the request path');
    }) as never;
    forbidden = [dbMock.dbRead, dbMock.dbWrite].flatMap((client) => [
      ...['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', '$transaction'].map(
        (m) => client[m]
      ),
      ...['userCosmetic', 'cosmetic', 'image', 'model', 'article', 'post'].flatMap((model) =>
        ['findMany', 'findFirst', 'findUnique'].map((m) => client[model][m])
      ),
    ]);
    for (const method of forbidden) method.mockReset().mockImplementation(refuse);
    caches.worn.fetch.mockResolvedValue({});
    caches.visible.fetch.mockResolvedValue({ 5: { id: 5 } });
    redisMock.sysRedis.hGet.mockResolvedValue(null);
    at(LIVE_NOW);
  });

  it('in the preview, gives the worn hat its keyed id, never its live one', async () => {
    wearing();
    inHatMap('claimed');
    at(PREVIEW_NOW);
    expect((await read())?.topicId).toBe(previewTopicId('birthday2026', '9:31:claimed'));
    expect(engine.getReadableScoredEvent).toHaveBeenCalledWith('birthday2026', viewer);
  });

  afterEach(() => {
    const called = forbidden.filter((method) => method.mock.calls.length).length;
    for (const method of forbidden) method.mockReset();
    expect(called, 'Postgres was called by the popover').toBe(0);
  });

  it('refuses an event the viewer may not read, and reads nothing', async () => {
    engine.getReadableScoredEvent.mockImplementation(notStarted);
    await expect(read()).rejects.toThrow("That event doesn't exist");
    expect(caches.worn.fetch).not.toHaveBeenCalled();
    expect(caches.visible.fetch).not.toHaveBeenCalled();
  });

  it('is null when no hat of the event is on that content', async () => {
    expect(await read()).toBeNull();
    expect(caches.worn.fetch).toHaveBeenCalledWith([5]);
    // Content with no hat never costs a visibility lookup.
    expect(caches.visible.fetch).not.toHaveBeenCalled();
    expect(scoring.getCosmeticScores).not.toHaveBeenCalled();
  });

  it('is null while the content is not public, and for a type that is never public', async () => {
    wearing();
    caches.visible.fetch.mockResolvedValue({});
    expect(await read()).toBeNull();
    expect(caches.visible.fetch).toHaveBeenCalledWith([5]);
    expect(
      await service.getWornEventHat({
        event: 'birthday2026',
        entityType: 'Post',
        entityId: 5,
        viewer,
      })
    ).toBeNull();
    // Positive control: the same hat on public content is found.
    caches.visible.fetch.mockResolvedValue({ 5: { id: 5 } });
    expect(await read()).toMatchObject({ cosmeticId: 31 });
  });

  it("is null for another event's hat", async () => {
    wearing({ ...decoration, data: { ...decoration.data, event: 'holiday2026' } });
    expect(await read()).toBeNull();
  });

  it('names the hat without its team, its wearer, and what it has earned, by the hat map', async () => {
    wearing();
    inHatMap('claimed');
    (await userBasic()).mockResolvedValueOnce({
      9: { id: 9, username: 'civ', image: 'a.png', deletedAt: null },
    } as never);
    (await profilePictures()).mockResolvedValueOnce({ 9: { id: 70, url: 'p.png' } } as never);
    scoring.getCosmeticScores.mockResolvedValue({
      '9:31:claimed': settled('claimed', 12, {
        impressions: 300,
        anonImpressions: 40,
        reactions: 7,
        comments: 5,
        stickers: 4,
        remixes: 3,
      }),
    });
    live.getHatPoints.mockResolvedValue({ '9:31:claimed': 64 });
    at(LIVE_NOW);
    expect(await read()).toEqual({
      cosmeticId: 31,
      name: 'Party Cap',
      team: 'Blue',
      url: 'blue.png',
      owner: { id: 9, username: 'civ', image: 'a.png', profilePicture: { id: 70, url: 'p.png' } },
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'claimed' }),
      // Live, not the snapshot's 12.
      points: 64,
      impressions: 340,
      reactions: 7,
      comments: 5,
      stickers: 4,
      remixes: 3,
    });
    expect(live.getHatPoints).toHaveBeenCalledWith(season, [
      { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' },
    ]);
    expect(scoring.getCosmeticScores.mock.calls[0].slice(0, 2)).toEqual([
      scored,
      [{ userId: 9, cosmeticId: 31, claimKey: 'claimed' }],
    ]);
    expect(scoring.getUserCosmeticScores).not.toHaveBeenCalled();
    // The wearer, not the viewer (id 1).
    expect(await userBasic()).toHaveBeenCalledWith([9]);
    expect(await profilePictures()).toHaveBeenCalledWith([9]);
  });

  // After the event the hat map is no longer kept, but the hat stays on the content.
  it("finds a hat missing from the hat map by its owner's only settled copy of the design", async () => {
    wearing();
    scoring.getUserCosmeticScores.mockResolvedValue([
      settled('txn-1', 40),
      { ...settled('claimed', 90), cosmeticId: 77 },
    ]);
    scoring.getCosmeticScores.mockResolvedValue({ '9:31:txn-1': settled('txn-1', 40) });
    live.getHatPoints.mockResolvedValue(null as never);
    expect(await read()).toMatchObject({
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'txn-1' }),
    });
    expect(scoring.getUserCosmeticScores.mock.calls[0].slice(0, 2)).toEqual([scored, 9]);
  });

  // A stale map entry: another owner's hat, or this owner's other design, once on this content.
  it.each([
    ['someone else', { ownerId: 12 }],
    ['another design of the same owner', { cosmeticId: 77 }],
  ])("ignores a hat map entry for %s's hat, and falls back to the settled copy", async (_, hat) => {
    wearing();
    inHatMap('other', hat);
    scoring.getUserCosmeticScores.mockResolvedValue([settled('txn-1', 40)]);
    expect(await read()).toMatchObject({
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'txn-1' }),
    });
  });

  it('shows the hat and its owner without points when two copies of the design leave it ambiguous', async () => {
    wearing();
    (await userBasic()).mockResolvedValueOnce({
      9: { id: 9, username: 'civ', image: null, deletedAt: null },
    } as never);
    scoring.getUserCosmeticScores.mockResolvedValue([settled('claimed', 5), settled('txn-1', 40)]);
    expect(await read()).toEqual({
      cosmeticId: 31,
      name: 'Party Cap',
      team: 'Blue',
      url: 'blue.png',
      owner: { id: 9, username: 'civ', image: null, profilePicture: null },
      topicId: null,
      points: 0,
      impressions: 0,
      reactions: 0,
      comments: 0,
      stickers: 0,
      remixes: 0,
    });
    expect(scoring.getCosmeticScores).not.toHaveBeenCalled();
    expect(live.getHatPoints).not.toHaveBeenCalled();
  });

  it('falls back to the settled copy and reports it degraded when the hat map is unreachable', async () => {
    wearing();
    redisMock.sysRedis.hGet.mockRejectedValue(new Error('sysredis down'));
    scoring.getUserCosmeticScores.mockResolvedValue([settled('txn-1', 40)]);
    const onDegraded = vi.fn();
    expect(await read(onDegraded)).toMatchObject({
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'txn-1' }),
    });
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('falls back to the snapshot points when the live totals are unreachable', async () => {
    wearing();
    inHatMap('claimed');
    scoring.getCosmeticScores.mockResolvedValue({ '9:31:claimed': settled('claimed', 12) });
    live.getHatPoints.mockRejectedValue(new Error('sysredis down'));
    const onDegraded = vi.fn();
    expect(await read(onDegraded)).toMatchObject({ points: 12 });
    // The route skips the edge cache for this answer.
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });

  it('does not report a live answer as degraded, and hands the settled read the same callback', async () => {
    wearing();
    inHatMap('claimed');
    const onDegraded = vi.fn();
    await read(onDegraded);
    expect(onDegraded).not.toHaveBeenCalled();
    expect(scoring.getCosmeticScores.mock.calls[0][2]).toBe(onDegraded);
  });

  // The popover is public and edge-cached: the claim key (a purchase's transaction id) stays home.
  it('never returns the claim key', async () => {
    wearing();
    inHatMap('txn-secret-42');
    expect(JSON.stringify(await read())).not.toContain('txn-secret-42');
  });

  it('keeps the whole name of a hat with no team', async () => {
    wearing({ ...decoration, data: { type: 'hat', event: 'birthday2026', url: 'u' } });
    expect(await read()).toMatchObject({ name: 'Party Cap - Blue', team: null });
  });

  it('hides a deleted wearer and reads an unscored hat as zero', async () => {
    wearing();
    inHatMap('claimed');
    (await userBasic()).mockResolvedValueOnce({
      9: { id: 9, username: 'civ', image: null, deletedAt: new Date() },
    } as never);
    expect(await read()).toMatchObject({
      owner: null,
      topicId: hatTopicId({ ownerId: 9, cosmeticId: 31, claimKey: 'claimed' }),
      points: 0,
      impressions: 0,
      reactions: 0,
    });
  });
});

describe('wornEventHatSchema', () => {
  it('takes one piece of content by type and id', async () => {
    const { wornEventHatSchema } = await import('~/server/schema/event.schema');
    const ok = { event: 'birthday2026', entityType: 'Image', entityId: 5 };
    expect(wornEventHatSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, entityType: 'Hat' },
      { ...ok, entityId: 0 },
      { ...ok, entityId: 1.5 },
      { ...ok, entityId: '5' },
    ])
      expect(wornEventHatSchema.safeParse(bad).success).toBe(false);
  });
});
