import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CrucibleService from '~/server/services/crucible.service';
import type { ProtectedContext } from '~/server/createContext';
import { loggingMock } from '~/__tests__/mocks';

const cancelCrucible = vi.fn();

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  cancelCrucible,
}));

const { cancelCrucibleHandler } = await import('~/server/controllers/crucible.controller');

const ctx = { user: { id: 3, isModerator: true } } as unknown as ProtectedContext;
const result = (failedRefunds: { entryId: number | null; userId: number; error: string }[]) => ({
  crucibleId: 9,
  refundedEntries: 1,
  totalRefunded: 10,
  refundedSeed: 0,
  alreadySettled: 0,
  failedRefunds,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cancelCrucibleHandler', () => {
  it('logs refunds that failed, since the moderator may not read the result', async () => {
    const failedRefunds = [{ entryId: 1, userId: 10, error: 'buzz down' }];
    cancelCrucible.mockResolvedValue(result(failedRefunds));

    await expect(cancelCrucibleHandler({ input: { id: 9 }, ctx })).resolves.toMatchObject({
      failedRefunds,
    });

    expect(cancelCrucible).toHaveBeenCalledWith({ id: 9, userId: 3, isModerator: true });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-cancel-refund-failed',
        crucibleId: 9,
        failedRefunds,
      })
    );
  });

  it('logs nothing when every refund landed', async () => {
    cancelCrucible.mockResolvedValue(result([]));

    await cancelCrucibleHandler({ input: { id: 9 }, ctx });

    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});
