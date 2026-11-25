import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The owner of an App Assistant client (`appassist-<their id>`) cannot edit it from the OAuth-apps
 * page: not its name, redirect URIs, origins or scopes, and not its secret. Deleting it (turning App
 * Assistant off) stays allowed. Other clients the user owns are edited as before.
 */

vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn(async () => undefined),
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  findCatalogParentIdsForClient: vi.fn(async () => []),
}));
vi.mock('~/server/services/blocks/oauth-consent-sync.service', () => ({
  withdrawCatalogItemsOnClientDelete: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/key-generator', () => ({
  generateKey: () => 'new-secret',
  generateSecretHash: (s: string) => `hash:${s}`,
}));
vi.mock('~/server/services/download-link/download-link.store', () => ({
  isAllowlistedMinter: () => false,
  revokeLinksOfRevokedCredentials: vi.fn(async () => undefined),
}));

const { oauthClientRouter } = await import('../oauth-client.router');

const OWNER = { id: 7, isModerator: false, bannedAt: null };
const OWN_ASSISTANT = 'appassist-7';

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

function owns(id: string, extra: Record<string, unknown> = {}) {
  dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
    id,
    userId: OWNER.id,
    allowedScopes: TokenScope.UserRead,
    skipConsent: false,
    isConfidential: false,
    ...extra,
  });
}

beforeEach(() => {
  resetSharedMocks();
  dbMock.dbWrite.oauthClient.update.mockImplementation(async ({ data }: { data: unknown }) => data);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([]);
});

describe('oauthClient on an App Assistant client', () => {
  it.each([
    ['a rename', { name: 'Totally Official App' }],
    ['a redirect URI', { redirectUris: ['https://attacker.example/cb'] }],
    ['allowed origins', { allowedOrigins: ['https://attacker.example'] }],
    ['wider scopes', { allowedScopes: Number(TokenScope.Full) }],
  ])('🔴 refuses %s and writes nothing', async (_what, change) => {
    owns(OWN_ASSISTANT);
    await expect(caller().update({ id: OWN_ASSISTANT, ...change })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('🔴 refuses a secret rotation and writes nothing', async () => {
    owns(OWN_ASSISTANT, { isConfidential: true });
    await expect(caller().rotateSecret({ id: OWN_ASSISTANT })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('still lets the owner delete it (turning App Assistant off)', async () => {
    owns(OWN_ASSISTANT);
    await expect(caller().delete({ id: OWN_ASSISTANT })).resolves.toEqual({ success: true });
    expect(dbMock.dbWrite.oauthClient.delete).toHaveBeenCalledWith({
      where: { id: OWN_ASSISTANT },
    });
  });

  it('control: the same edit to an ordinary client the user owns is written', async () => {
    owns('game-frame');
    await caller().update({ id: 'game-frame', redirectUris: ['https://g.example/cb'] });
    expect(dbMock.dbWrite.oauthClient.update).toHaveBeenCalledWith({
      where: { id: 'game-frame' },
      data: { redirectUris: ['https://g.example/cb'] },
    });
  });
});
