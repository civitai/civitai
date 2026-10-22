import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeySpend from '~/server/http/orchestrator/api-key-spend';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Revoking an app's access withdraws the store items its platform listed under the user's name
 * (catalog sync). The withdraw itself is executed on real rows in
 * `src/server/services/blocks/__tests__/app-sub-listing-catalog-creator.behavior.test.ts`; this
 * pins that revoking an app runs it, for the right user and client, after the consent is gone,
 * and that a failure never blocks the revoke.
 */

const { withdrawMock, deleteSubjectMock, invalidateMock } = vi.hoisted(() => ({
  withdrawMock: vi.fn(),
  deleteSubjectMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  withdrawCatalogSubListingsForRevokedConsent: withdrawMock,
}));
vi.mock('~/server/http/orchestrator/api-key-spend', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeySpend>()),
  deleteAuthSubject: deleteSubjectMock,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: invalidateMock,
}));

const { oauthConsentRouter } = await import('~/server/routers/oauth-consent.router');
const { createCallerFactory } = await import('~/server/trpc');
const { revokeOauthConsentForBlock } = await import(
  '~/server/services/blocks/oauth-consent-sync.service'
);

const USER_ID = 5150;
const CLIENT_ID = 'client-platform';
const APP_BLOCK_ID = 'apb_platform';

const caller = createCallerFactory(oauthConsentRouter)({
  user: { id: USER_ID, bannedAt: null, muted: false },
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: {},
  track: {},
  ip: '127.0.0.1',
  cache: {},
  req: undefined,
  res: undefined,
} as never);

beforeEach(() => {
  withdrawMock.mockReset();
  withdrawMock.mockResolvedValue(3);
  invalidateMock.mockClear();
  deleteSubjectMock.mockClear();
  dbMock.dbWrite.oauthConsent.findUnique.mockReset();
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ id: 9, userId: USER_ID });
  dbMock.dbWrite.oauthConsent.delete.mockReset();
  dbMock.dbWrite.oauthConsent.delete.mockResolvedValue({ id: 9 });
  dbMock.dbWrite.oauthConsent.deleteMany.mockReset();
  dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.apiKey.deleteMany.mockReset();
  dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 2 });
  dbMock.dbRead.appBlock.findUnique.mockReset();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ appId: CLIENT_ID });
});

describe('oauthConsent.revokeApp', () => {
  it("withdraws the user's catalog items for that client, after deleting the consent", async () => {
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).resolves.toEqual({
      success: true,
      catalogItemsWithdrawn: 3,
    });
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(withdrawMock).toHaveBeenCalledWith({ userId: USER_ID, clientId: CLIENT_ID });
    expect(withdrawMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.dbWrite.oauthConsent.delete.mock.invocationCallOrder[0]
    );
  });

  it('expires the revoked tokens in the auth cache before withdrawing the items', async () => {
    await caller.revokeApp({ clientId: CLIENT_ID });
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      withdrawMock.mock.invocationCallOrder[0]
    );
  });

  it('still revokes when the withdraw fails, and reports it as null', async () => {
    withdrawMock.mockRejectedValueOnce(new Error('store down'));
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).resolves.toEqual({
      success: true,
      catalogItemsWithdrawn: null,
    });
    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.oauthConsent.delete).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('withdraws nothing when there is no consent to revoke', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValueOnce(null);
    await expect(caller.revokeApp({ clientId: CLIENT_ID })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});

describe('revokeOauthConsentForBlock (an app block permission narrowing)', () => {
  // Invariant guard: it deletes a consent MIRROR that the next token mint rebuilds from the
  // grant, so it is not a user disconnecting a platform and must not withdraw catalog items.
  it('does not withdraw catalog items', async () => {
    await revokeOauthConsentForBlock({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledTimes(1);
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});
