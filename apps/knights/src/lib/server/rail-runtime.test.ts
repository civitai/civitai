import { describe, expect, it, vi } from 'vitest';

// Distinct objects, so a read that takes the primary instead of the replica fails `toBe`.
const PRIMARY = vi.hoisted(() => ({ client: 'primary' }));
const REPLICA = vi.hoisted(() => ({ client: 'replica' }));
const queryBoard = vi.hoisted(() => vi.fn());
const votesOnDay = vi.hoisted(() => vi.fn());
const boardGet = vi.hoisted(() => vi.fn());
vi.mock('./db', () => ({ db: PRIMARY, dbRead: REPLICA }));
vi.mock('./leaderboard', () => ({ queryBoard }));
vi.mock('./leaderboard-runtime', () => ({ boardCache: { get: boardGet } }));
vi.mock('./rail', async (original) => ({
  ...(await original<typeof import('./rail')>()),
  votesOnDay,
}));

const { railFor } = await import('./rail-runtime');

describe('railFor', () => {
  it('builds the shared board and counts the day’s votes on the replica', async () => {
    const now = new Date('2026-12-15T12:00:00Z');
    boardGet.mockImplementation((_now: Date, build: () => Promise<unknown>) => build());
    queryBoard.mockResolvedValue({ rows: [{ userId: 7, username: 'Me', fervor: 10 }] });
    votesOnDay.mockResolvedValue(42);

    const rail = await railFor(7, now);

    expect(rail).toMatchObject({ standing: { position: 1 }, activity: 42 });
    expect(queryBoard).toHaveBeenCalledTimes(1);
    expect(queryBoard.mock.calls[0][0]).toBe(REPLICA);
    expect(queryBoard.mock.calls[0][1]).toBe(now);
    expect(votesOnDay).toHaveBeenCalledTimes(1);
    expect(votesOnDay.mock.calls[0][0]).toBe(REPLICA);
    expect(votesOnDay.mock.calls[0][1]).toBe('2026-12-15');
  });
});
