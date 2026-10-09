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

// The tRPC context carries no key type, so User and System keys reach the gate identically.
const bearers: [string, Record<string, unknown>][] = [
  ['a full-scope User key', { apiKeyId: 1, subject: { type: 'apiKey', id: 1 } }],
  ['a full-scope System key', { apiKeyId: 2, subject: { type: 'apiKey', id: 2 } }],
  [
    'an OAuth access token for a different client',
    { apiKeyId: 3, subject: { type: 'oauth', id: 'other-client' } },
  ],
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

describe.each(procedures)('oauthConsent.$name requires a browser session', (procedure) => {
  // A missing consent answers NOT_FOUND, which can only come from inside the handler.
  it('reaches the handler for a browser session', async () => {
    await expect(procedure.call(createCaller(ctx()))).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    );
    expect(dbMock.dbWrite.oauthConsent.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each(bearers)('refuses %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'This action cannot be performed via API key or OAuth token.',
      })
    );
    expect(dbMock.dbWrite.oauthConsent.findUnique).not.toHaveBeenCalled();
  });
});
