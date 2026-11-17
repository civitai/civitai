import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Rotating the secret of a client on `DOWNLOAD_LINK_CLIENT_IDS` also expires the tokens it issued,
 * so a token from before the rotation cannot mint new links (the bearer lookup refuses an expired
 * row). Every other client keeps its tokens, as rotation always has.
 */

vi.mock('~/server/services/orchestrator/civitai', () => ({
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/key-generator', () => ({
  generateKey: () => 'new-secret',
  generateSecretHash: () => 'hashed',
}));

const { oauthClientRouter } = await import('../oauth-client.router');

const OWNER = { id: 7, isModerator: false, bannedAt: null, muted: false };

function caller() {
  return oauthClientRouter.createCaller({
    acceptableOrigin: true,
    user: OWNER,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

const TOKENS = [
  { id: 11, key: 'hash-access' },
  { id: 12, key: 'hash-refresh' },
];

beforeEach(() => {
  resetSharedMocks();
  setEnv({ DOWNLOAD_LINK_CLIENT_IDS: ['minter'] });
  dbMock.dbWrite.oauthClient.findFirst.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      userId: OWNER.id,
      isConfidential: true,
    })
  );
  dbMock.dbWrite.oauthClient.update.mockResolvedValue({});
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue(TOKENS);
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: TOKENS.length });
});

describe('oauthClient.rotateSecret for a download-link minter', () => {
  it("expires the minter's live Access and Refresh tokens, keeping the rows", async () => {
    const before = Date.now();
    expect(await caller().rotateSecret({ id: 'minter' })).toEqual({ clientSecret: 'new-secret' });

    const [{ where }] = dbMock.dbWrite.apiKey.findMany.mock.calls[0];
    expect(where).toMatchObject({ clientId: 'minter', type: { in: ['Access', 'Refresh'] } });
    expect(dbMock.dbWrite.apiKey.updateMany).toHaveBeenCalled();
    const [{ where: updated, data }] = dbMock.dbWrite.apiKey.updateMany.mock.calls[0];
    expect(updated).toEqual({ id: { in: [11, 12] } });
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
  });

  // Order decided: the minter re-checks its token after reading the secret, which only stops an
  // old token if the tokens were expired BEFORE the secret changed. Do not move the first pass.
  it('expires the tokens before writing the new secret, and again after it', async () => {
    await caller().rotateSecret({ id: 'minter' });
    const expiries = dbMock.dbWrite.apiKey.updateMany.mock.invocationCallOrder;
    const [secretWrite] = dbMock.dbWrite.oauthClient.update.mock.invocationCallOrder;
    expect(expiries).toHaveLength(2);
    expect(expiries[0]).toBeLessThan(secretWrite);
    expect(expiries[1]).toBeGreaterThan(secretWrite);
  });

  it('keeps the old secret when expiring the tokens fails', async () => {
    dbMock.dbWrite.apiKey.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(caller().rotateSecret({ id: 'minter' })).rejects.toThrow();
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('leaves the tokens of a client not on the list alone', async () => {
    await caller().rotateSecret({ id: 'third-party' });
    expect(dbMock.dbWrite.apiKey.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.apiKey.updateMany).not.toHaveBeenCalled();
  });
});
