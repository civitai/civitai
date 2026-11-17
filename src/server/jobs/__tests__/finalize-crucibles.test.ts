import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks';
import type * as CrucibleService from '~/server/services/crucible.service';

const finalizeCrucible = vi.fn();

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  activateScheduledCrucibles: vi.fn(async () => 0),
  voidUnscannedCrucibles: vi.fn(async () => []),
  getCruciblesForFinalization: vi.fn(async () => [1, 2]),
  finalizeCrucible,
}));

const { finalizeCruciblesJob } = await import('~/server/jobs/finalize-crucibles');
const { CrucibleRankingDeferredError } = await import('~/server/services/crucible-bradley-terry');

describe('finalize-crucibles — a crucible waiting on ClickHouse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is deferred, not logged as a failure, and does not stop the next crucible', async () => {
    finalizeCrucible.mockImplementation(async (id: number) => {
      if (id === 1) throw new CrucibleRankingDeferredError('ClickHouse has 3 of 4 votes, waiting');
      return { finalEntries: [], totalPrizesDistributed: 0 };
    });

    const result = await finalizeCruciblesJob.run({}).result;

    expect(result).toMatchObject({ finalized: 1, failed: 0, deferredIds: [1], successIds: [2] });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('still logs any other error as a failure', async () => {
    finalizeCrucible.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error('boom');
      return { finalEntries: [], totalPrizesDistributed: 0 };
    });

    const result = await finalizeCruciblesJob.run({}).result;

    expect(result).toMatchObject({ finalized: 1, failed: 1, deferredIds: [] });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to finalize crucible' }),
      'webhooks'
    );
  });
});
