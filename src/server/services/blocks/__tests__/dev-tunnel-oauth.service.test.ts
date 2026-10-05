import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';

const { mintAppTokenMock } = vi.hoisted(() => ({
  mintAppTokenMock: vi.fn(async () => ({
    accessToken: 'civ_dev_oauth',
    expiresAt: '2099-01-01T00:15:00Z',
    expiresIn: 900,
    scope: 0,
  })),
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  mintAppToken: mintAppTokenMock,
}));
vi.mock('~/server/http/orchestrator/api-key-spend', () => ({
  bustBuzzLimitCache: vi.fn(async () => undefined),
  deleteAuthSubject: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));

import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  devTunnelClientId,
  mintDevTunnelOauthToken,
  parseDevTunnelClientId,
  scopesCoveredByConsent,
} from '../dev-tunnel-oauth.service';

const USER_ID = 42;
const SPEND = TokenScope.UserRead | TokenScope.AIServicesWrite;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.oauthClient.upsert.mockResolvedValue({ id: 'x' });
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.oauthConsent.upsert.mockResolvedValue({ id: 1 });
});

describe('dev tunnel client ids', () => {
  it('round-trips and refuses anything that is not one of ours', () => {
    expect(parseDevTunnelClientId(devTunnelClientId(USER_ID, 'my-app'))).toEqual({
      userId: USER_ID,
      slug: 'my-app',
    });
    expect(parseDevTunnelClientId('appblk-my-app')).toBeNull();
    expect(parseDevTunnelClientId('appdev-42-')).toBeNull();
    expect(parseDevTunnelClientId('appdev-x-my-app')).toBeNull();
    expect(parseDevTunnelClientId('appdev-42-My App')).toBeNull();
  });
});

describe('scopesCoveredByConsent', () => {
  it('keeps a scope only when the consent carries its bit; block-only scopes pass', () => {
    expect(
      scopesCoveredByConsent(
        ['ai:write:budgeted', 'user:read:self', 'collections:read:self'],
        TokenScope.UserRead
      )
    ).toEqual(['user:read:self', 'collections:read:self']);
  });
});

describe('mintDevTunnelOauthToken', () => {
  it('creates the borrowed client, consents the author to it, and mints through the hub', async () => {
    const minted = await mintDevTunnelOauthToken({
      userId: USER_ID,
      clientId: 'appdev-42-my-app',
      scopes: ['ai:write:budgeted', 'user:read:self'],
    });

    expect(minted).toEqual({ token: 'civ_dev_oauth', expiresAt: '2099-01-01T00:15:00Z' });
    const client = dbMock.dbWrite.oauthClient.upsert.mock.calls[0][0];
    expect(client.where).toEqual({ id: 'appdev-42-my-app' });
    expect(client.create).toMatchObject({
      userId: USER_ID,
      redirectUris: [],
      grants: [],
      allowedScopes: SPEND,
    });
    expect(client.update).toEqual({ allowedScopes: SPEND });

    const consent = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(consent.where).toEqual({
      userId_clientId: { userId: USER_ID, clientId: 'appdev-42-my-app' },
    });
    expect(consent.create.scope).toBe(SPEND);
    expect(consent.create.buzzLimit).toEqual([
      expect.objectContaining({ limit: 5000, window: 'day' }),
    ]);
    expect(mintAppTokenMock).toHaveBeenCalledWith({
      userId: USER_ID,
      clientId: 'appdev-42-my-app',
      scope: SPEND,
    });
  });

  it('leaves a submitted app’s real client alone and writes no spend limit for a read-only grant', async () => {
    await mintDevTunnelOauthToken({
      userId: USER_ID,
      clientId: 'appblk-my-app',
      scopes: ['user:read:self'],
    });
    expect(dbMock.dbWrite.oauthClient.upsert).not.toHaveBeenCalled();
    const consent = dbMock.dbWrite.oauthConsent.upsert.mock.calls[0][0];
    expect(consent.create.scope).toBe(TokenScope.UserRead);
    expect(consent.create.buzzLimit).toBe(Prisma.DbNull);
  });

  it('refuses to mint on another author’s dev client', async () => {
    await expect(
      mintDevTunnelOauthToken({ userId: 7, clientId: 'appdev-42-my-app', scopes: [] })
    ).rejects.toThrow(/another user/);
    expect(mintAppTokenMock).not.toHaveBeenCalled();
  });
});
