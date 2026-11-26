import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as SubListingService from '~/server/services/blocks/app-sub-listing.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Deleting an OAuth client withdraws the store items its platform listed under its catalog
 * parents. The withdraw itself is executed on real rows in
 * `src/server/services/blocks/__tests__/app-sub-listing-catalog-creator.behavior.test.ts`; this
 * pins that the delete reads the parents before the client is gone, withdraws only after the
 * delete succeeded, and is not blocked by a failed withdraw.
 */

const { findParentsMock, withdrawMock, invalidateMock } = vi.hoisted(() => ({
  findParentsMock: vi.fn(),
  withdrawMock: vi.fn(),
  invalidateMock: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubListingService>()),
  findCatalogParentIdsForClient: findParentsMock,
  withdrawCatalogSubListingsForDeletedClient: withdrawMock,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: invalidateMock,
}));

const { oauthClientRouter } = await import('~/server/routers/oauth-client.router');
const { createCallerFactory } = await import('~/server/trpc');

const OWNER_ID = 6160;
const CLIENT_ID = '7d1f5c2e-1111-4222-8333-944455556666';
const PARENT_IDS = ['apl_PARENT_ONE', 'apl_PARENT_TWO'];

const caller = createCallerFactory(oauthClientRouter)({
  user: { id: OWNER_ID, bannedAt: null, muted: false },
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
  findParentsMock.mockReset();
  findParentsMock.mockResolvedValue(PARENT_IDS);
  withdrawMock.mockReset();
  withdrawMock.mockResolvedValue(4);
  invalidateMock.mockClear();
  loggingMock.logToAxiom.mockClear();
  dbMock.dbWrite.oauthClient.findFirst.mockReset();
  dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({ id: CLIENT_ID, userId: OWNER_ID });
  dbMock.dbWrite.oauthClient.delete.mockReset();
  dbMock.dbWrite.oauthClient.delete.mockResolvedValue({ id: CLIENT_ID });
  dbMock.dbWrite.apiKey.findMany.mockReset();
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([{ userId: 7170 }]);
});

describe('oauthClient.delete', () => {
  it("reads the client's catalog parents before the delete and withdraws their items after it", async () => {
    await expect(caller.delete({ id: CLIENT_ID })).resolves.toEqual({ success: true });
    expect(findParentsMock).toHaveBeenCalledWith(CLIENT_ID);
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(withdrawMock).toHaveBeenCalledWith({ parentListingIds: PARENT_IDS });
    const deleteOrder = dbMock.dbWrite.oauthClient.delete.mock.invocationCallOrder[0];
    expect(findParentsMock.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
    expect(withdrawMock.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
  });

  it('withdraws nothing when the delete fails', async () => {
    dbMock.dbWrite.oauthClient.delete.mockRejectedValueOnce(new Error('delete failed'));
    await expect(caller.delete({ id: CLIENT_ID })).rejects.toThrow('delete failed');
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it('still deletes when the withdraw fails', async () => {
    withdrawMock.mockRejectedValueOnce(new Error('store down'));
    await expect(caller.delete({ id: CLIENT_ID })).resolves.toEqual({ success: true });
    expect(dbMock.dbWrite.oauthClient.delete).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith({ userId: 7170 });
  });

  // Once the delete unlinks the parents nothing can find them, so a failed lookup must fail the
  // delete (a safe retry) rather than strand the items.
  it('does not delete when the parent lookup fails', async () => {
    findParentsMock.mockRejectedValueOnce(new Error('store down'));
    await expect(caller.delete({ id: CLIENT_ID })).rejects.toThrow('store down');
    expect(dbMock.dbWrite.oauthClient.delete).not.toHaveBeenCalled();
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it('touches nothing for a client the caller does not own', async () => {
    dbMock.dbWrite.oauthClient.findFirst.mockResolvedValueOnce(null);
    await expect(caller.delete({ id: CLIENT_ID })).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    expect(findParentsMock).not.toHaveBeenCalled();
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});

// Deleting an App Assistant client stays allowed (it turns App Assistant off), unlike editing it,
// unless staff or a ban disabled it: the next enable or dev-tunnel mint would recreate it open.
describe('oauthClient.delete on a self-only client', () => {
  it('deletes an open one', async () => {
    const id = `appassist-${OWNER_ID}`;
    dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
      id,
      userId: OWNER_ID,
      accessMode: 'open',
    });
    await expect(caller.delete({ id })).resolves.toEqual({ success: true });
    expect(dbMock.dbWrite.oauthClient.delete).toHaveBeenCalledWith({ where: { id } });
  });

  it.each([`appassist-${OWNER_ID}`, `appdev-${OWNER_ID}-pose-board`])(
    '🔴 refuses deleting %s once it is disabled, and deletes nothing',
    async (id) => {
      dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
        id,
        userId: OWNER_ID,
        accessMode: 'disabled',
      });
      await expect(caller.delete({ id })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'This app is disabled and cannot be removed here',
      });
      expect(dbMock.dbWrite.oauthClient.delete).not.toHaveBeenCalled();
    }
  );

  it('control: a disabled third-party client is not covered by this refusal', async () => {
    dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
      id: CLIENT_ID,
      userId: OWNER_ID,
      accessMode: 'disabled',
    });
    await expect(caller.delete({ id: CLIENT_ID })).resolves.toEqual({ success: true });
  });
});
