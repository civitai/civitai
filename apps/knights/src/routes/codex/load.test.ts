import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlayerStatusOrNew = vi.hoisted(() => vi.fn());
const startAtRow = vi.hoisted(() => ({ value: undefined as { startAt: Date } | undefined }));
vi.mock('$lib/server/db', () => ({
  db: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst: async () => startAtRow.value }) }),
    }),
  },
}));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatusOrNew }));
vi.mock('$lib/server/rank-badges', () => ({
  rankBadgeUrls: async () => ({ small: {}, large: { Knight: 'k450' } }),
}));

const { load } = await import('./+page.server');
const run = () => load({ locals: { user: { id: 7 } } } as never) as Promise<Record<string, any>>;

beforeEach(() => {
  getPlayerStatusOrNew.mockReset();
  getPlayerStatusOrNew.mockResolvedValue({ rank: 'Knight', level: 12 });
  startAtRow.value = { startAt: new Date('2026-03-14T00:00:00Z') };
});

describe('codex load', () => {
  it("gives the ladder from config with each rank's gold multiplier and daily cap, and no vote weight", async () => {
    const page = await run();
    expect(page.ranks.map((r: { rank: string }) => r.rank)).toEqual([
      'Knight',
      'Templar',
      'Paladin',
    ]);
    expect(page.ranks[1]).not.toHaveProperty('voteWeight');
    expect(page.ranks[1]).toMatchObject({
      goldMultiplier: 1.25,
      dailyGoldCap: { from: 140_000, to: 180_000 },
    });
    expect(page.ranks[0]).toHaveProperty('levels');
    expect(page.ranks[0]).toHaveProperty('accuracyBar');
  });

  it("carries the player's status, the large badge images and the date they were sworn in", async () => {
    const page = await run();
    expect(page.status).toEqual({ rank: 'Knight', level: 12 });
    expect(page.badges).toEqual({ Knight: 'k450' });
    expect(page.swornIn).toBe('2026-03-14T00:00:00.000Z');
  });

  it('quotes the rules facts, with the fervor formula read from config', async () => {
    const page = await run();
    expect(page.facts.hearts.max).toBe(3);
    expect(page.facts.fervor).toMatchObject({ scale: 100, windowDays: 7 });
    expect(page.fervorExample.sum).toBe('100 × 100 × 80% × 80% = 6,400');
  });

  it('has no sworn-in date for someone without a career yet', async () => {
    startAtRow.value = undefined;
    expect((await run()).swornIn).toBeNull();
  });
});
