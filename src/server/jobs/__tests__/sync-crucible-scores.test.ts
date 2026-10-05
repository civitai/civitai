import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import { dbMock } from '~/__tests__/mocks';

const getAllElos = vi.fn();
const getAllVoteCounts = vi.fn();

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { getAllElos, getAllVoteCounts },
}));

const { syncCrucibleScoresJob } = await import('~/server/jobs/sync-crucible-scores');

const renderedUpdates = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map(([strings, ...values]) =>
    Prisma.sql(strings as TemplateStringsArray, ...values).text.replace(/\s+/g, ' ')
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucible.findMany.mockResolvedValue([{ id: 1, name: 'Neon' }]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('sync-crucible-scores after a Redis wipe', () => {
  it('writes nothing for a crucible whose ratings Redis no longer has', async () => {
    getAllElos.mockResolvedValue({});
    getAllVoteCounts.mockResolvedValue({});

    await syncCrucibleScoresJob.run({}).result;

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('never lowers a stored vote count, so a lost count cannot overwrite Postgres', async () => {
    getAllElos.mockResolvedValue({ 10: 1520 });
    getAllVoteCounts.mockResolvedValue({});

    await syncCrucibleScoresJob.run({}).result;

    const [sql] = renderedUpdates();
    expect(sql).toContain('"voteCount" = GREATEST(e."voteCount", v.vote_count)');
    expect(sql).toContain('(10, 1520, 0)');
  });
});
