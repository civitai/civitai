import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(async () => ({})),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
}));

/**
 * The sidebar badge (getLeaderboardPositions) and the board list (getLeaderboard) must read
 * the same stored `LeaderboardResult.date` for the same request. When they didn't, a tester
 * saw their badge at #33 and their row at #37 — one side was a day behind.
 *
 * prepare-leaderboard stamps rows with Postgres `current_date`, picking tomorrow's date by the
 * UTC hour, so a board's day is the UTC calendar day. A server whose local zone is not UTC must
 * not shift either reader off it: 03:00Z is still the previous evening in Denver.
 */
const NOV_12_0300Z = new Date('2026-11-12T03:00:00Z');

const listDay = () => {
  const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1) as unknown[];
  return call.slice(1).find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
};
const badgeDay = () => {
  const arg = dbMock.dbRead.leaderboardResult.findMany.mock.calls.at(-1)?.[0] as {
    where: { date: Date };
  };
  return arg.where.date.toISOString().slice(0, 10);
};

describe('leaderboard serve day', () => {
  const originalTz = process.env.TZ;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOV_12_0300Z);
    process.env.TZ = 'America/Denver';
    // Control: if the zone didn't take (e.g. a thread pool's private env), the badge check is vacuous.
    expect(new Date(2026, 10, 11).getUTCHours()).toBe(7);
  });
  afterEach(() => {
    process.env.TZ = originalTz;
    vi.useRealTimers();
  });

  it('badge and list read the same UTC day on a non-UTC server', async () => {
    const { getLeaderboard, getLeaderboardPositions } = await import('../leaderboard.service');

    await getLeaderboard({ id: 'images-funny', isModerator: false } as never);
    await getLeaderboardPositions({ userId: 1, top: 1000, isModerator: false } as never);

    expect(listDay()).toBe('2026-11-12');
    expect(badgeDay()).toBe('2026-11-12');
  });

  it('reads today, not the next day the 23:00 run just wrote', async () => {
    vi.setSystemTime(new Date('2026-11-12T23:30:00Z'));
    const { getLeaderboard, getLeaderboardPositions } = await import('../leaderboard.service');

    await getLeaderboard({ id: 'images-funny', isModerator: false } as never);
    await getLeaderboardPositions({ userId: 1, top: 1000, isModerator: false } as never);

    expect(listDay()).toBe('2026-11-12');
    expect(badgeDay()).toBe('2026-11-12');
  });

  it('an explicit date resolves to the same day on both sides', async () => {
    const { getLeaderboard, getLeaderboardPositions } = await import('../leaderboard.service');
    const date = new Date('2026-11-10T00:00:00Z');

    await getLeaderboard({ id: 'images-funny', date, isModerator: false } as never);
    await getLeaderboardPositions({ userId: 1, date, top: 1000, isModerator: false } as never);

    expect(listDay()).toBe('2026-11-10');
    expect(badgeDay()).toBe('2026-11-10');
  });
});
