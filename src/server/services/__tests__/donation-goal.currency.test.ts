import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A donation reaches the creator in the currency the donor gave.
 *
 * It did not: the charge named no destination account, so the buzz service
 * applied its yellow default and a green donation arrived as yellow — 137 legs
 * / 85,210 Buzz between 2025-11-21 and 2026-08-09. Same defect as paid access
 * (#3917) and placements (#3911), and the third place it was found.
 */

const { createMultiAccountBuzzTransaction, refundMultiAccountTransaction } = vi.hoisted(() => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));
import { donateToGoal } from '~/server/services/donation-goal.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const DONOR = 20;
const CREATOR = 10;
const GOAL_ID = 77;

const seed = () => {
  mockDbWrite.donationGoal.findUniqueOrThrow.mockResolvedValue({
    id: GOAL_ID,
    title: 'A goal',
    userId: CREATOR,
    active: true,
    isEarlyAccess: false,
    entityType: 'ModelVersion',
    entityId: 555,
    goalAmount: 1000,
  });
  mockDbRead.$queryRaw.mockResolvedValue([{ total: 0 }]);
  mockDbWrite.$queryRaw.mockResolvedValue([{ total: 0 }]);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactionIds: ['tx-1'] });
  mockDbWrite.donation.create.mockResolvedValue({});
};

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe('donateToGoal — the creator receives what the donor gave', () => {
  it.each(['green', 'yellow'] as const)('pays a %s donation in kind', async (buzzType) => {
    await donateToGoal({ donationGoalId: GOAL_ID, amount: 500, userId: DONOR, buzzType }).catch(
      () => undefined
    );

    const charge = createMultiAccountBuzzTransaction.mock.calls[0][0];
    expect(charge.fromAccountTypes).toEqual([buzzType]);
    expect(charge.toAccountType).toBe(buzzType);
    expect(charge.toAccountId).toBe(CREATOR);
  });

  // Blue is refused before any money moves. It is non-transferable, so a blue
  // donation paying the creator ANY currency is a transfer channel for it —
  // and the pre-fix behaviour was worse than paying blue: it paid YELLOW,
  // turning free Buzz into cashable currency.
  it('refuses Blue Buzz without charging anything', async () => {
    await expect(
      donateToGoal({ donationGoalId: GOAL_ID, amount: 500, userId: DONOR, buzzType: 'blue' })
    ).rejects.toThrow(/Blue Buzz/);

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });
});
