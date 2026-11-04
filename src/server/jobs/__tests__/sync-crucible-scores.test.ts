import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as BradleyTerry from '~/server/services/crucible-bradley-terry';
import { dbMock } from '~/__tests__/mocks';

const getAllElos = vi.fn();
const getAllVoteCounts = vi.fn();
const fitCrucibleScores = vi.fn();

vi.mock('~/server/services/crucible-bradley-terry', async (importOriginal) => ({
  ...(await importOriginal<typeof BradleyTerry>()),
  fitCrucibleScores,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { getAllElos, getAllVoteCounts },
}));

const { syncCrucibleScoresJob } = await import('~/server/jobs/sync-crucible-scores');
const { BRADLEY_TERRY_RANKING_FROM } = await import('~/server/services/crucible-bradley-terry');

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
  const crucible = (startOffsetMs: number) => ({
    id: 1,
    name: 'Neon',
    startAt: new Date(BRADLEY_TERRY_RANKING_FROM!.getTime() + startOffsetMs),
    createdAt: new Date(0),
  });
  beforeEach(() => {
    getAllElos.mockResolvedValue({ 10: 1520, 11: 1480 });
    getAllVoteCounts.mockResolvedValue({ 10: 3, 11: 3 });
    fitCrucibleScores.mockResolvedValue(new Map([[10, 1610]]));
  });

  it('is the fit for a crucible started after the switch, Elo where the fit has no votes yet', async () => {
    dbMock.dbRead.crucible.findMany.mockResolvedValue([crucible(1000)]);
    await syncCrucibleScoresJob.run({}).result;
    expect(renderedUpdates()[0]).toContain('(10, 1610, 3), (11, 1480, 3)');
  });

  it('stays Elo for a crucible started before the switch', async () => {
    dbMock.dbRead.crucible.findMany.mockResolvedValue([crucible(-1000)]);
    await syncCrucibleScoresJob.run({}).result;
    expect(fitCrucibleScores).not.toHaveBeenCalled();
    expect(renderedUpdates()[0]).toContain('(10, 1520, 3), (11, 1480, 3)');
  });

  it('still syncs Elo when the fit fails', async () => {
    dbMock.dbRead.crucible.findMany.mockResolvedValue([crucible(1000)]);
    fitCrucibleScores.mockRejectedValue(new Error('ClickHouse down'));
    await syncCrucibleScoresJob.run({}).result;
    expect(renderedUpdates()[0]).toContain('(10, 1520, 3), (11, 1480, 3)');
  });
});
