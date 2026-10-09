import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The service layer is where the scored-event routes meet the engine. These pin that every scored
 * read goes through the engine's access gate for the viewer, and that the join branch only
 * side-effects on a real join.
 */

const { engine, scoring } = vi.hoisted(() => ({
  engine: {
    getReadableScoredEvent: vi.fn(),
    assertReadable: vi.fn(),
    isJoinEvent: vi.fn(),
    join: vi.fn(),
    queueAddRole: vi.fn(),
    getUserData: vi.fn(),
  },
  scoring: {
    getEventStandings: vi.fn(),
    getUserCosmeticScores: vi.fn(),
    getCosmeticScores: vi.fn(),
  },
}));

vi.mock('~/server/events', () => ({ eventEngine: engine }));
vi.mock('~/server/events/scoring/cosmetic-placement.service', () => scoring);
vi.mock('~/server/redis/caches', () => ({
  cosmeticCache: { fetch: vi.fn(async () => ({ 21: { name: 'Party Cap - Yellow' } })) },
  profilePictureCache: { fetch: vi.fn() },
  refreshOwnedStickerCache: vi.fn(),
  userBasicCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticDetail: vi.fn(async ({ id }: { id: number }) => ({ id })),
}));
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
