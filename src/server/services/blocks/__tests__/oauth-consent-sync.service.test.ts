import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

const { bustMock, deleteSubjectMock, invalidateMock } = vi.hoisted(() => ({
  bustMock: vi.fn(async () => undefined),
  deleteSubjectMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: bustMock,
  deleteAuthSubject: deleteSubjectMock,
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: invalidateMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  revokeOauthConsentForBlock,
  syncOauthConsentFromGrant,
} from '../oauth-consent-sync.service';

const USER_ID = 7;
const APP_BLOCK_ID = 'apb_sync';
const CLIENT_ID = 'app_sync';
const DAY_LIMIT = (limit: number) => [{ type: 'sliding', limit, window: 'day', unit: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ appId: CLIENT_ID });
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
    grantedScopes: ['ai:write:budgeted', 'apps:storage:read', 'collections:read:private'],
    revokedAt: null,
    buzzBudgetPerDay: 500,
  });
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.oauthConsent.upsert.mockResolvedValue({ id: 1 });
});

describe('syncOauthConsentFromGrant', () => {
  it('maps granted scopes to OAuth bits plus UserRead and the daily budget to a sliding limit', async () => {
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    const scope = TokenScope.UserRead | TokenScope.AIServicesWrite;
    expect(result).toEqual({ clientId: CLIENT_ID, scope });
    const upsert = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ userId_clientId: { userId: USER_ID, clientId: CLIENT_ID } });
    expect(upsert.create).toMatchObject({ userId: USER_ID, clientId: CLIENT_ID, scope });
    expect(upsert.update).toEqual({ scope, buzzLimit: DAY_LIMIT(500) });
    expect(bustMock).not.toHaveBeenCalled();
  });

  it('busts the orchestrator limit cache only when an existing consent limit changed', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ buzzLimit: DAY_LIMIT(100) });

    await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(bustMock).toHaveBeenCalledWith({
      userId: USER_ID,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
  });

  it('mirrors the consent-exempt scopes a token is asked for, even without a grant row', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      scopes: ['models:read:self', 'apps:storage:read'],
    });

    const scope = TokenScope.UserRead | TokenScope.ModelsRead;
    expect(result).toEqual({ clientId: CLIENT_ID, scope });
    expect(dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0].update).toEqual({
      scope,
      buzzLimit: expect.anything(),
    });
  });

  it('returns null and writes nothing when the grant is revoked', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted'],
      revokedAt: new Date(),
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
  });
});

describe('revokeOauthConsentForBlock', () => {
  it('deletes the consent and its tokens and invalidates the orchestrator subject', async () => {
    await revokeOauthConsentForBlock({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(dbMock.dbWrite.apiKey.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, clientId: CLIENT_ID, type: { in: ['Access', 'Refresh'] } },
    });
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, clientId: CLIENT_ID },
    });
    expect(deleteSubjectMock).toHaveBeenCalledWith({
      userId: USER_ID,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    expect(invalidateMock).toHaveBeenCalledWith({ userId: USER_ID });
  });
});
