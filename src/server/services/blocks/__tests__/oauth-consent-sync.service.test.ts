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
  it('maps granted scopes to OAuth bits and the daily budget to a sliding limit', async () => {
    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    // The grant fixture does NOT contain `user:read:self`, so the mirrored row must
    // NOT claim `UserRead` (#5127 — this assertion used to read
    // `UserRead | AIServicesWrite`, pinning the bug as intended behaviour).
    // `apps:storage:read` / `collections:read:private` are SKIP_OAUTH_CHECK, so they
    // contribute no bit.
    const scope = TokenScope.AIServicesWrite;
    expect(result).toEqual({ clientId: CLIENT_ID, scope });
    expect(result!.scope & TokenScope.UserRead).toBe(0);
    const upsert = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ userId_clientId: { userId: USER_ID, clientId: CLIENT_ID } });
    expect(upsert.create).toMatchObject({ userId: USER_ID, clientId: CLIENT_ID, scope });
    expect(upsert.update).toEqual({ scope, buzzLimit: DAY_LIMIT(500) });
    expect(bustMock).not.toHaveBeenCalled();
  });

  it('asserts UserRead when — and only when — the viewer granted user:read:self', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['user:read:self', 'buzz:read:self'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(result).toEqual({
      clientId: CLIENT_ID,
      scope: TokenScope.UserRead | TokenScope.BuzzRead,
    });
  });

  it('busts the orchestrator limit cache only when an existing consent limit changed', async () => {
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ buzzLimit: DAY_LIMIT(100) });

    await syncOauthConsentFromGrant({ userId: USER_ID, appBlockId: APP_BLOCK_ID });

    expect(bustMock).toHaveBeenCalledWith({
      userId: USER_ID,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
  });

  // 🔴 #5127 REGRESSION. This case previously asserted the opposite — that a viewer
  // with NO grant row still got a row mirroring `UserRead | ModelsRead`. That was the
  // vulnerability written down as a spec: the hub then validated consent against the
  // row this call had just manufactured, and an `auth: "oauth"` block read the
  // viewer's email from /api/v1/me while the same mint reported `user:read:self` as
  // missing. A viewer who has consented to nothing gets nothing written.
  it('writes nothing and returns null when the viewer has no grant row at all', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      scopes: ['models:read:self', 'apps:storage:read'],
    });

    expect(result).toBeNull();
    expect(dbMock.dbWrite.oauthConsent.upsert).not.toHaveBeenCalled();
  });

  // #5127, second shape: a grant row EXISTS, so the guard above does not fire, but it
  // does not contain the consent-gated scope the caller is asking a token for. The
  // caller-supplied list may only widen the row by CONSENT-EXEMPT scopes.
  it('ignores consent-gated scopes the caller asks for but the viewer never granted', async () => {
    dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['apps:storage:write'],
      revokedAt: null,
      buzzBudgetPerDay: null,
    });

    const result = await syncOauthConsentFromGrant({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      // exempt: models:read:self (→ ModelsRead), apps:storage:read (→ no bit).
      // gated and NOT granted: user:read:self (→ UserRead), buzz:read:self (→ BuzzRead).
      scopes: ['user:read:self', 'buzz:read:self', 'models:read:self', 'apps:storage:read'],
    });

    expect(result).toEqual({ clientId: CLIENT_ID, scope: TokenScope.ModelsRead });
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
