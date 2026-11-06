import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelNsfw from '~/server/services/text-scan/actions/model-nsfw';

/**
 * A moderator's availability toggle is one of the writes that takes a model out of Private, so a
 * scan verdict held while it was Private applies in the same transaction.
 */

const { mockLeavingPrivate, mockFinishApply } = vi.hoisted(() => ({
  mockLeavingPrivate: vi.fn(async (_db: unknown, _id: number) => false),
  mockFinishApply: vi.fn(async (_id: number) => undefined),
}));
vi.mock('~/server/services/text-scan/actions/model-nsfw', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelNsfw>()),
  applyHeldVerdictLeavingPrivate: mockLeavingPrivate,
  finishHeldVerdictApply: mockFinishApply,
}));
vi.mock('~/server/services/paid-access.service', () => ({ getPaidAccess: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  lookupModelVersionAccess: vi.fn(),
  modelVersionAccessCache: { fetch: vi.fn(), bust: vi.fn() },
}));

const { entityAvailabilityUpdate } = await import('~/server/services/common.service');

const tx = { $executeRawUnsafe: vi.fn(async () => 1) };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (t: unknown) => unknown) =>
    fn(tx)) as never);
});

describe('entityAvailabilityUpdate', () => {
  it('applies a held verdict on each model it takes out of Private, then finishes it', async () => {
    mockLeavingPrivate.mockImplementation(async (_db, id) => id === 2);
    await entityAvailabilityUpdate({
      entityType: 'Model',
      entityIds: [1, 2],
      availability: 'Public',
    });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    // The availability write and the applies share the transaction's client.
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      mockLeavingPrivate.mock.invocationCallOrder[0]
    );
    expect(mockLeavingPrivate.mock.calls).toEqual([
      [tx, 1],
      [tx, 2],
    ]);
    expect(mockFinishApply.mock.calls).toEqual([[2]]);
  });

  it.each([
    ['Model', 'Private'],
    ['ModelVersion', 'Public'],
  ] as const)('applies nothing for %s set %s (control)', async (entityType, availability) => {
    await entityAvailabilityUpdate({ entityType, entityIds: [1], availability });
    expect(dbMock.dbWrite.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockLeavingPrivate).not.toHaveBeenCalled();
  });
});
