import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';

const { mockGetTransactions } = vi.hoisted(() => ({ mockGetTransactions: vi.fn() }));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzTransactions: mockGetTransactions,
}));

import { modRouter } from '~/server/routers/moderator';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const MOD_ID = 7;
const TARGET_ID = 1234;

function callerFor({
  isModerator,
  cashManagement,
}: {
  isModerator: boolean;
  cashManagement: boolean;
}) {
  return modRouter.createCaller({
    user: { id: MOD_ID, isModerator },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { trpcFlagGuardPerRequest: true, cashManagement },
    track: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTransactions.mockResolvedValue({ cursor: null, transactions: [] });
});

describe('mod.cash.getCashTransactions', () => {
  it("reads the target user's cash account, not the moderator's", async () => {
    await callerFor({ isModerator: true, cashManagement: true }).cash.getCashTransactions({
      userId: TARGET_ID,
      accountType: 'cashPending',
    });

    expect(mockGetTransactions).toHaveBeenCalledTimes(1);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: TARGET_ID, accountType: 'cashPending', limit: 50 })
    );
  });

  it('refuses a moderator without the cashManagement flag', async () => {
    await expect(
      callerFor({ isModerator: true, cashManagement: false }).cash.getCashTransactions({
        userId: TARGET_ID,
        accountType: 'cashSettled',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it('refuses a non-moderator even with the flag on', async () => {
    await expect(
      callerFor({ isModerator: false, cashManagement: true }).cash.getCashTransactions({
        userId: TARGET_ID,
        accountType: 'cashSettled',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });
});
