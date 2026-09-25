import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

const { revokeConsentMock } = vi.hoisted(() => ({
  revokeConsentMock: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/oauth-consent-sync.service', () => ({
  revokeOauthConsentForBlock: revokeConsentMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { revokeBlockGrantsForClient, revokeScopeGrant } from '../scope-grant-revocation.service';

const USER_ID = 7;
const APP_BLOCK_ID = 'apb_withdraw';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.appUserScopeGrant.updateMany.mockResolvedValue({ count: 1 });
});

describe('revokeScopeGrant', () => {
  it('marks the grant revoked and drops the mirrored consent', async () => {
    await revokeScopeGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(dbMock.dbWrite.appUserScopeGrant.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, appBlockId: { in: [APP_BLOCK_ID] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(revokeConsentMock).toHaveBeenCalledWith({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
  });
});

describe('revokeBlockGrantsForClient', () => {
  it('revokes only the grants for blocks the client owns, leaving the consent to the caller', async () => {
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([{ id: 'apb_a' }, { id: 'apb_b' }]);

    await expect(revokeBlockGrantsForClient({ userId: USER_ID, clientId: 'app_x' })).resolves.toBe(
      1
    );

    expect(dbMock.dbRead.appBlock.findMany).toHaveBeenCalledWith({
      where: { appId: 'app_x' },
      select: { id: true },
    });
    expect(dbMock.dbWrite.appUserScopeGrant.updateMany.mock.calls[0][0].where).toEqual({
      userId: USER_ID,
      appBlockId: { in: ['apb_a', 'apb_b'] },
      revokedAt: null,
    });
    expect(revokeConsentMock).not.toHaveBeenCalled();
  });

  it('touches nothing for a client without blocks', async () => {
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([]);

    await expect(revokeBlockGrantsForClient({ userId: USER_ID, clientId: 'app_x' })).resolves.toBe(
      0
    );
    expect(dbMock.dbWrite.appUserScopeGrant.updateMany).not.toHaveBeenCalled();
  });
});
