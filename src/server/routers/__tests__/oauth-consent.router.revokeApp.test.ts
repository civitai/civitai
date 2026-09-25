import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

const { deleteSubjectMock, invalidateMock, revokeGrantsMock } = vi.hoisted(() => ({
  deleteSubjectMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
  revokeGrantsMock: vi.fn(async () => 1),
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: deleteSubjectMock,
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: invalidateMock,
}));
vi.mock('~/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('~/server/services/blocks/scope-grant-revocation.service', () => ({
  revokeBlockGrantsForClient: revokeGrantsMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { oauthConsentRouter } from '../oauth-consent.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const USER_ID = 42;
const CLIENT_ID = 'app_connected';

function caller() {
  return oauthConsentRouter.createCaller({
    acceptableOrigin: true,
    user: { id: USER_ID } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ id: 1 });
});

describe('oauthConsent.revokeApp', () => {
  it('revokes the caller’s block grants for the client after removing its consent', async () => {
    await expect(caller().revokeApp({ clientId: CLIENT_ID })).resolves.toEqual({ success: true });

    expect(dbMock.dbWrite.oauthConsent.delete).toHaveBeenCalledWith({
      where: { userId_clientId: { userId: USER_ID, clientId: CLIENT_ID } },
    });
    expect(revokeGrantsMock).toHaveBeenCalledWith({ userId: USER_ID, clientId: CLIENT_ID });
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('touches no grant when there is no consent to revoke', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);

    await expect(caller().revokeApp({ clientId: CLIENT_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(revokeGrantsMock).not.toHaveBeenCalled();
  });
});
