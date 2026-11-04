import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as BradleyTerry from '~/server/services/crucible-bradley-terry';
import { dbMock } from '~/__tests__/mocks';

const getAllElos = vi.fn();
const getAllVoteCounts = vi.fn();
const fitCrucibleScores = vi.fn();
const usesBradleyTerryRanking = vi.fn(() => false);

vi.mock('~/server/services/crucible-bradley-terry', async (importOriginal) => ({
  ...(await importOriginal<typeof BradleyTerry>()),
  fitCrucibleScores,
  usesBradleyTerryRanking,
}));

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

describe('sync-crucible-scores — the displayed score', () => {
  beforeEach(() => {
    getAllElos.mockResolvedValue({ 10: 1520, 11: 1480 });
    getAllVoteCounts.mockResolvedValue({ 10: 3, 11: 3 });
    fitCrucibleScores.mockResolvedValue(new Map([[10, 1610]]));
  });

  it('is the fit where the switch covers the crucible, Elo where the fit has no votes yet', async () => {
    usesBradleyTerryRanking.mockReturnValue(true);
    await syncCrucibleScoresJob.run({}).result;
    expect(renderedUpdates()[0]).toContain('(10, 1610, 3), (11, 1480, 3)');
  });

  it('stays Elo where the switch does not cover the crucible', async () => {
    usesBradleyTerryRanking.mockReturnValue(false);
    await syncCrucibleScoresJob.run({}).result;
    expect(fitCrucibleScores).not.toHaveBeenCalled();
    expect(renderedUpdates()[0]).toContain('(10, 1520, 3), (11, 1480, 3)');
  });

  it('still syncs Elo when the fit fails', async () => {
    usesBradleyTerryRanking.mockReturnValue(true);
    fitCrucibleScores.mockRejectedValue(new Error('ClickHouse down'));
    await syncCrucibleScoresJob.run({}).result;
    expect(renderedUpdates()[0]).toContain('(10, 1520, 3), (11, 1480, 3)');
  });
});
