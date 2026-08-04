import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contesting a "depicts a minor" flag goes through the existing Appeal system
 * (Task 5). `createEntityAppeal` must accept a `skipFee` flag and skip both the
 * 30-day appeal count and the Buzz charge when set — the fee still applies to
 * every other appeal type.
 */

const { mockGetAppealCount } = vi.hoisted(() => ({ mockGetAppealCount: vi.fn() }));

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const tx = { image: { update: vi.fn() }, appeal: { create: vi.fn() } };
  return {
    mockDbRead: { appeal: { count: mockGetAppealCount } },
    mockDbWrite: {
      $transaction: vi.fn((cb: (tx: typeof tx) => unknown) => cb(tx)),
      appeal: { create: vi.fn() },
    },
  };
});

const { mockCreateMultiAccountBuzzTransaction, mockRefundMultiAccountTransaction } = vi.hoisted(
  () => ({
    mockCreateMultiAccountBuzzTransaction: vi.fn(),
    mockRefundMultiAccountTransaction: vi.fn(),
  })
);

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/services/buzz.service')>()),
  createMultiAccountBuzzTransaction: mockCreateMultiAccountBuzzTransaction,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));

import { createEntityAppeal } from '~/server/services/report.service';
import { EntityType } from '~/shared/utils/prisma/enums';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.appeal.create.mockResolvedValue({ id: 1 });
});

describe('createEntityAppeal — skipFee', () => {
  it('does not charge a fee for a model appeal even past the free allowance', async () => {
    mockGetAppealCount.mockResolvedValue(5);

    await createEntityAppeal({
      entityId: 2186217,
      entityType: EntityType.Model,
      message: 'This is my own character design.',
      userId: 602767,
      buzzType: 'user',
      skipFee: true,
    });

    expect(mockCreateMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('does not even count prior appeals when skipFee is set', async () => {
    // The count query only exists to gate the charge — running it with nothing to
    // gate would be a pointless dbRead on every fee-free appeal.
    mockGetAppealCount.mockResolvedValue(5);

    await createEntityAppeal({
      entityId: 2186217,
      entityType: EntityType.Model,
      message: 'This is my own character design.',
      userId: 602767,
      buzzType: 'user',
      skipFee: true,
    });

    expect(mockGetAppealCount).not.toHaveBeenCalled();
  });

  it('still charges the fee for a non-model appeal past the free allowance', async () => {
    mockGetAppealCount.mockResolvedValue(3);
    mockCreateMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 1 });

    await createEntityAppeal({
      entityId: 99,
      entityType: EntityType.Image,
      message: 'Please review again.',
      userId: 602767,
      buzzType: 'user',
    });

    expect(mockCreateMultiAccountBuzzTransaction).toHaveBeenCalled();
  });
});
