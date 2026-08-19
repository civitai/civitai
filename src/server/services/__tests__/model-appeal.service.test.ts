import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Contesting a "depicts a minor" flag goes through the existing Appeal system.
 * `createEntityAppeal` must accept a `skipFee` flag and skip both the 30-day
 * appeal count and the Buzz charge when set — the fee still applies to every
 * other appeal type.
 */

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockGetAppealCount = mockDbRead.appeal.count;

// The transaction client is DELIBERATELY not `dbMock.dbWrite`. This fixture's `tx` was a separate
// object, so `dbWrite.appeal.create` only ever saw calls made OUTSIDE the transaction; handing the
// callback the canonical write client instead would collapse the two and let an in-transaction
// call satisfy an assertion that means "written outside the transaction".
const tx = { image: { update: vi.fn() }, appeal: { create: vi.fn() } };
mockDbWrite.$transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx));

const { mockCreateMultiAccountBuzzTransaction, mockRefundMultiAccountTransaction } = vi.hoisted(
  () => ({
    mockCreateMultiAccountBuzzTransaction: vi.fn(),
    mockRefundMultiAccountTransaction: vi.fn(),
  })
);

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCreateMultiAccountBuzzTransaction,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));

import { createEntityAppeal } from '~/server/services/report.service';
import { EntityType } from '~/shared/utils/prisma/enums';

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.appeal.create.mockResolvedValue({ id: 1 });
  mockCreateMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 1 });
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
