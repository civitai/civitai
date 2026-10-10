import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { oauthConsentRouter } from '~/server/routers/oauth-consent.router';
import { createCallerFactory } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const createCaller = createCallerFactory(oauthConsentRouter);

const USER = { id: 41, bannedAt: null, muted: false };

function ctx(credential: Record<string, unknown> = {}) {
  return {
    user: USER,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
    ...credential,
  } as never;
}

// Keeps UserWrite, so a refusal here can only come from the credential check.
const REDUCED = TokenScope.Full & ~TokenScope.UserRead;
const key = (apiKeyType: string | undefined, tokenScope = TokenScope.Full) => ({
  apiKeyId: 1,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id: 1 },
  tokenScope,
});

const allowed: [string, Record<string, unknown>][] = [
  ['a browser session', {}],
  ['a full-scope personal API key', key('User')],
];

const refused: [string, Record<string, unknown>][] = [
  ['a full-scope System key', key('System')],
  [
    'a full-scope OAuth access token for a different client',
    {
      apiKeyId: 3,
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: 'other-client' },
      tokenScope: TokenScope.Full,
    },
  ],
  ['a reduced-scope personal API key', key('User', REDUCED)],
  ['a key whose type was not recorded', key(undefined)],
];

const procedures = [
  {
    name: 'setBuzzLimit',
    call: (c: ReturnType<typeof createCaller>) =>
      c.setBuzzLimit({ clientId: 'target-client', buzzLimit: null }),
  },
  {
    name: 'revokeApp',
    call: (c: ReturnType<typeof createCaller>) => c.revokeApp({ clientId: 'target-client' }),
  },
];

beforeEach(() => {
  dbMock.dbWrite.oauthConsent.findUnique.mockReset();
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
});

describe.each(procedures)('oauthConsent.$name credential requirements', (procedure) => {
  // A missing consent answers NOT_FOUND, which can only come from inside the handler.
  it.each(allowed)('reaches the handler for %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    expect(dbMock.dbWrite.oauthConsent.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(refused)('refuses %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'This action requires a signed-in session or a full-access personal API key.',
      })
    );
    expect(dbMock.dbWrite.oauthConsent.findUnique).not.toHaveBeenCalled();
  });
});
