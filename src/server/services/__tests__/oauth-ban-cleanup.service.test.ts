import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';

// The token expiry is api-key.service's own (covered there); here it is the boundary this leg calls.
const { expireClientTokens } = vi.hoisted(() => ({
  expireClientTokens: vi.fn(async (_clientId: string) => ({ expired: 0 })),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  expireClientTokens,
}));

const { disableOauthForBannedUser } = await import('../oauth-ban-cleanup.service');

const USER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.oauthClient.findMany.mockResolvedValue([
    { id: 'b1e0c0de-0000-4000-8000-000000000001' },
    { id: `appassist-${USER}` },
  ] as never);
  dbMock.dbWrite.oauthClient.updateMany.mockResolvedValue({ count: 2 } as never);
  dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 3 } as never);
});

describe('disableOauthForBannedUser', () => {
  it('🔴 disables every OAuth client the user owns, App Assistant’s included, and expires their tokens', async () => {
    const result = await disableOauthForBannedUser(USER);

    expect(dbMock.dbWrite.oauthClient.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER,
        accessMode: { not: 'disabled' },
        NOT: { id: { startsWith: 'appblk-' } },
      },
      select: { id: true },
    });
    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['b1e0c0de-0000-4000-8000-000000000001', `appassist-${USER}`] } },
      data: { accessMode: 'disabled' },
    });
    expect(expireClientTokens.mock.calls.map(([id]) => id)).toEqual([
      'b1e0c0de-0000-4000-8000-000000000001',
      `appassist-${USER}`,
    ]);
    expect(result).toEqual({
      clients: ['b1e0c0de-0000-4000-8000-000000000001', `appassist-${USER}`],
      consents: 3,
    });
  });

  it('🔴 deletes every consent the user gave', async () => {
    await disableOauthForBannedUser(USER);
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });

  it('with nothing left to disable, writes no client and still clears consents', async () => {
    dbMock.dbWrite.oauthClient.findMany.mockResolvedValue([] as never);
    dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 0 } as never);
    expect(await disableOauthForBannedUser(USER)).toEqual({ clients: [], consents: 0 });
    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(expireClientTokens).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
  });
});
