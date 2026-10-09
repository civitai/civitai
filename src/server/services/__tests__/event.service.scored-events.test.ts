import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DecorationConstants from '~/shared/constants/event-decoration.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

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

vi.mock('~/server/events', () => ({ eventEngine: engine }));
// The real cosmeticScoreKey: the service joins scores to hats with it.
vi.mock('~/server/events/scoring/cosmetic-placement.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...scoring,
}));
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { fetch: vi.fn(async () => ({ 21: { name: 'Party Cap - Yellow' } })) },
  profilePictureCache: { fetch: vi.fn() },
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
const scored = { name: 'birthday2026', teams: ['Yellow', 'Blue'] };

beforeEach(() => {
  vi.clearAllMocks();
  engine.getReadableScoredEvent.mockResolvedValue(scored);
  scoring.getEventStandings.mockResolvedValue({ teams: [], topCosmetics: [], topUsers: {} });
  scoring.getUserCosmeticScores.mockResolvedValue([]);
  scoring.getCosmeticScores.mockResolvedValue({});
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
    await service.getTeamScores({ event: 'birthday2026', viewer });
    await service.getTeamScoreHistory({ event: 'birthday2026', viewer });
    expect(engine.getTeamScores).toHaveBeenCalledWith('birthday2026', 'preview');
    expect(engine.getTeamScoreHistory).toHaveBeenCalledWith({ event: 'birthday2026' }, 'preview');
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
      '9:31:claimed': { points: 140, impressions: 90, anonImpressions: 10, reactions: 4 },
    });
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
    const hats = await service.getMyEventHats({ event: 'birthday2026', user });
    expect(hats.map((h) => [h.cosmeticId, h.claimKey])).toEqual([
      [31, 'claimed'],
      [32, 'txn-9'],
    ]);
    expect(hats[0]).toMatchObject({
      points: 140,
      impressions: 100,
      reactions: 4,
      placedOn: { entityType: 'Image', entityId: 500, image: { id: 77 } },
    });
    expect(hats[1]).toMatchObject({ points: 0, placedOn: null, movableAt: null });
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

  // The art is decoration: a failed lookup must cost the hats, never the standings.
  it('still answers when the join hat lookup fails', async () => {
    engine.getJoinHats.mockRejectedValueOnce(new Error('redis down'));
    const res = await service.getEventStandings({ event: 'birthday2026', viewer });
    expect(res.teamHats).toEqual([]);
    expect(res.teams).toEqual([]);
  });
});
