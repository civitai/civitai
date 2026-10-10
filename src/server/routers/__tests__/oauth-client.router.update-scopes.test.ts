import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `oauthClient.update` from the OAuth-apps page: the owner edits the scopes within `Full`; the
 * opt-in bits above it are kept as they are and can be neither added nor removed there.
 */

vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));

const { oauthClientRouter } = await import('../oauth-client.router');

const OWNER = { id: 7, isModerator: false, bannedAt: null };
const CATALOG = TokenScope.AppStoreCatalogWrite;

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

const written = () => dbMock.dbWrite.oauthClient.update.mock.calls[0][0].data;

function existing(allowedScopes: number) {
  dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
    id: 'game-frame',
    userId: OWNER.id,
    allowedScopes,
  });
}

beforeEach(() => {
  resetSharedMocks();
  dbMock.dbWrite.oauthClient.update.mockImplementation(async ({ data }: { data: unknown }) => data);
});

describe('oauthClient.update scopes', () => {
  it('an edit that does not touch scopes leaves them alone', async () => {
    existing(TokenScope.UserRead | TokenScope.AIServicesWrite | CATALOG);
    await caller().update({
      id: 'game-frame',
      name: 'Games',
      redirectUris: ['https://g.example/cb'],
    });
    expect(written()).toEqual({ name: 'Games', redirectUris: ['https://g.example/cb'] });
  });

  it('a scope edit keeps every opt-in bit the client already has', async () => {
    existing(
      TokenScope.UserRead | TokenScope.AIServicesWrite | CATALOG | TokenScope.AppBlocksSubmit
    );
    await caller().update({ id: 'game-frame', allowedScopes: TokenScope.UserRead });
    expect(written().allowedScopes).toBe(
      TokenScope.UserRead | CATALOG | TokenScope.AppBlocksSubmit
    );
  });

  it('a scope edit cannot add an opt-in bit', async () => {
    existing(TokenScope.UserRead);
    await expect(
      caller().update({ id: 'game-frame', allowedScopes: TokenScope.UserRead | CATALOG })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();

    await caller().update({ id: 'game-frame', allowedScopes: TokenScope.Full });
    expect(written().allowedScopes).toBe(TokenScope.Full);
  });
});
