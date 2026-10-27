import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * System OAuth apps belong to the civitai system account (User -1) and are managed only from the
 * hub admin page. A session for -1 reaching this router sees none of them and changes none: the
 * owner-scoped procedures answer NOT_FOUND exactly as for someone else's client.
 */

vi.mock('~/server/services/orchestrator/civitai', () => ({
  revokeCivitaiUserTokens: vi.fn(async () => undefined),
}));

vi.mock('~/server/utils/key-generator', () => ({
  generateKey: () => 'new-secret',
  generateSecretHash: () => 'hashed',
}));

const { oauthClientRouter } = await import('../oauth-client.router');

const SYSTEM = { id: -1, isModerator: true, bannedAt: null, muted: false };
const SYSTEM_APP = { id: 'system-app', userId: -1, isConfidential: true, allowedScopes: 1 };

function caller(user: { id: number } = SYSTEM) {
  return oauthClientRouter.createCaller({
    acceptableOrigin: true,
    user: { isModerator: false, bannedAt: null, muted: false, ...user },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

beforeEach(() => {
  resetSharedMocks();
  // The DB matches the caller's own id, so the system app is what a -1 session's lookup finds.
  dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue(SYSTEM_APP);
  dbMock.dbRead.oauthClient.findMany.mockResolvedValue([SYSTEM_APP]);
});

describe('oauthClient router as the system account', () => {
  it('update answers NOT_FOUND and writes nothing', async () => {
    await expect(caller().update({ id: SYSTEM_APP.id, name: 'Renamed' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('rotateSecret answers NOT_FOUND and writes nothing', async () => {
    await expect(caller().rotateSecret({ id: SYSTEM_APP.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('delete answers NOT_FOUND and deletes nothing', async () => {
    await expect(caller().delete({ id: SYSTEM_APP.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.oauthClient.delete).not.toHaveBeenCalled();
  });

  it('getAll lists no system apps', async () => {
    expect(await caller().getAll()).toEqual([]);
  });

  it('create refuses to register a new system app', async () => {
    await expect(
      caller().create({
        name: 'New',
        redirectUris: ['https://x.example/cb'],
        allowedOrigins: [],
        isConfidential: true,
        allowedScopes: TokenScope.UserRead,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.oauthClient.create).not.toHaveBeenCalled();
  });

  it("searchForModerator's default (own clients) leaves system apps out", async () => {
    expect((await caller().searchForModerator({ limit: 20 })).items).toEqual([]);
  });
});

describe('oauthClient router as an account marked as a system account', () => {
  const MARKED = { id: 500 };
  const app = { ...SYSTEM_APP, userId: MARKED.id };

  beforeEach(() => {
    dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === MARKED.id ? { meta: { systemAccount: true } } : { meta: {} }
    );
    dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue(app);
  });

  it('cannot register an app', async () => {
    await expect(
      caller(MARKED).create({
        name: 'New',
        redirectUris: ['https://x.example/cb'],
        allowedOrigins: [],
        isConfidential: true,
        allowedScopes: TokenScope.UserRead,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.oauthClient.create).not.toHaveBeenCalled();
  });

  it('owns no app to update, rotate or delete', async () => {
    for (const call of [
      () => caller(MARKED).update({ id: app.id, name: 'Renamed' }),
      () => caller(MARKED).rotateSecret({ id: app.id }),
      () => caller(MARKED).delete({ id: app.id }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.oauthClient.delete).not.toHaveBeenCalled();
  });

  it('an ordinary account still registers an app', async () => {
    await caller({ id: 501 }).create({
      name: 'New',
      redirectUris: ['https://x.example/cb'],
      allowedOrigins: [],
      isConfidential: true,
      allowedScopes: TokenScope.UserRead,
    });
    expect(dbMock.dbWrite.oauthClient.create).toHaveBeenCalledTimes(1);
  });
});

describe('oauthClient.update on an app that skips consent', () => {
  const OWNER = { id: 7 };

  beforeEach(() => {
    dbMock.dbWrite.oauthClient.findFirst.mockResolvedValue({
      ...SYSTEM_APP,
      userId: OWNER.id,
      skipConsent: true,
    });
  });

  it.each(['http://app.example/cb', 'https://localhost/cb'])('refuses adding %s', async (uri) => {
    await expect(
      caller(OWNER).update({ id: SYSTEM_APP.id, redirectUris: ['https://app.example/cb', uri] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining(uri) });
    expect(dbMock.dbWrite.oauthClient.update).not.toHaveBeenCalled();
  });

  it('accepts https redirects off loopback', async () => {
    await caller(OWNER).update({ id: SYSTEM_APP.id, redirectUris: ['https://app.example/cb2'] });
    expect(dbMock.dbWrite.oauthClient.update).toHaveBeenCalledTimes(1);
  });
});
