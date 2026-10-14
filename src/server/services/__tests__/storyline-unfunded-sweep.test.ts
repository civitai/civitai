import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';

const settlePlacement = vi.fn();
const isPlacementEscrowFunded = vi.fn();
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement,
  isPlacementEscrowFunded,
}));

const { settleStaleUnfundedContinuations } = await import(
  '~/server/services/storyline-placement.service'
);

/**
 * What this sweep does with the rows its query selects. Which rows the query
 * selects is SQL, and is checked against Postgres, not here.
 */
describe('settling stale unfunded continuations', () => {
  const selected = (...rows: { id: number; amount: number }[]) =>
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(rows);

  beforeEach(() => {
    vi.clearAllMocks();
    isPlacementEscrowFunded.mockResolvedValue(false);
    settlePlacement.mockResolvedValue({ settled: true });
  });

  it('settles each one as an expiry', async () => {
    selected({ id: 1, amount: 100 }, { id: 2, amount: 50 });

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 2,
      settled: 2,
    });
    expect(settlePlacement.mock.calls.map((call) => call[0])).toEqual([
      { placementId: 1, action: 'expire' },
      { placementId: 2, action: 'expire' },
    ]);
  });

  // The holds may have landed between the query and this row: settling then
  // would refund money that is about to pay for an answer.
  it('leaves a row whose escrow filled since it was selected', async () => {
    selected({ id: 1, amount: 100 }, { id: 2, amount: 50 });
    isPlacementEscrowFunded.mockImplementation(async ({ placementId }) => placementId === 1);

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 2,
      settled: 1,
    });
    expect(isPlacementEscrowFunded).toHaveBeenCalledWith({ placementId: 1, amount: 100 });
    expect(settlePlacement.mock.calls.map((call) => call[0].placementId)).toEqual([2]);
  });

  it('counts only the rows it settled, not ones someone else settled first', async () => {
    selected({ id: 1, amount: 100 });
    settlePlacement.mockResolvedValue({ settled: false });

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 1,
      settled: 0,
    });
  });

  // One row that cannot be settled must not wedge every tick on the lowest id.
  it('carries on past a row that fails to settle', async () => {
    selected({ id: 1, amount: 100 }, { id: 2, amount: 50 });
    settlePlacement.mockRejectedValueOnce(new Error('buzz down'));

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 2,
      settled: 1,
    });
    expect(settlePlacement).toHaveBeenCalledTimes(2);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', placementId: 1, error: 'buzz down' })
    );
  });

  it('carries on past a row whose funding check fails', async () => {
    selected({ id: 1, amount: 100 }, { id: 2, amount: 50 });
    isPlacementEscrowFunded.mockRejectedValueOnce(new Error('db down'));

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 2,
      settled: 1,
    });
    expect(settlePlacement.mock.calls.map((call) => call[0].placementId)).toEqual([2]);
  });

  it('settles nothing when nothing is stale', async () => {
    selected();

    await expect(settleStaleUnfundedContinuations()).resolves.toEqual({
      considered: 0,
      settled: 0,
    });
    expect(settlePlacement).not.toHaveBeenCalled();
  });
});
