import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbWrite: { query: vi.fn() } }));
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateLeaderboardRank: vi.fn() }));
vi.mock('~/server/services/leaderboard.service', () => ({
  getUnpopulatedLeaderboards: vi.fn(),
  isLeaderboardPopulated: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgDbWrite } from '~/server/db/pgDb';
import { leaderboardPopulatedKey } from '~/server/services/new-creators.service';
import { clickhouseLeaderboardPopulation, markLeaderboardPopulated } from '../prepare-leaderboard';

describe('clickhouseLeaderboardPopulation without a ClickHouse client', () => {
  it('reports skipped so the job does not mark the board populated', async () => {
    const result = await clickhouseLeaderboardPopulation({
      jobContext: {} as never,
      id: 'generators',
      query: 'WITH clickhouse_x AS (SELECT 1) SELECT 1',
      includesCTE: true,
      addDays: 0,
    });
    expect(result).toBe(false);
    expect(pgDbWrite.query).not.toHaveBeenCalled();
  });
});

describe('markLeaderboardPopulated writer contract', () => {
  it('stores a plain YYYY-MM-DD string under leaderboardPopulatedKey(id)', async () => {
    vi.mocked(pgDbWrite.query).mockResolvedValue({ rows: [{ date: '2026-10-09' }] } as never);
    await markLeaderboardPopulated('generators', 0);
    const arg = dbMock.dbWrite.keyValue.upsert.mock.calls[0][0];
    expect(arg.where.key).toBe(leaderboardPopulatedKey('generators'));
    expect(arg.create.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.update.value).toBe(arg.create.value);
  });
});
