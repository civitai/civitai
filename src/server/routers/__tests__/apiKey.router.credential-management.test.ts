import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeyController from '~/server/controllers/api-key.controller';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { DOCS_API_KEY_SCOPE } from '~/shared/constants/docs-api-key.constants';

vi.mock('~/server/controllers/api-key.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyController>()),
  addApiKeyHandler: vi.fn(async () => 'added'),
  setBuzzLimitHandler: vi.fn(async () => 'limited'),
  deleteApiKeyHandler: vi.fn(async () => 'deleted'),
}));

const { apiKeyRouter } = await import('~/server/routers/apiKey.router');
const { createCallerFactory } = await import('~/server/trpc');
const { addApiKeyHandler, setBuzzLimitHandler, deleteApiKeyHandler } = await import(
  '~/server/controllers/api-key.controller'
);
const actualController = await vi.importActual<typeof ApiKeyController>(
  '~/server/controllers/api-key.controller'
);

const createCaller = createCallerFactory(apiKeyRouter);

const USER = {
  id: 31,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};

function ctx(credential: Record<string, unknown> = {}) {
  return {
    user: USER,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
    ...credential,
  } as never;
}

const REDUCED = TokenScope.Full & ~TokenScope.UserRead;
const key = (apiKeyType: string | undefined, tokenScope = TokenScope.Full, id = 1) => ({
  apiKeyId: id,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id },
  tokenScope,
});

const allowed: [string, Record<string, unknown>][] = [
  ['a browser session', {}],
  ['a full-scope personal API key', key('User')],
];

const refused: [string, Record<string, unknown>][] = [
  ['a full-scope System key', key('System')],
  [
    'a full-scope OAuth access token',
    {
      apiKeyId: 3,
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: 'c' },
      tokenScope: TokenScope.Full,
    },
  ],
  ['a reduced-scope personal API key', key('User', REDUCED)],
  ['a key whose type was not recorded', key(undefined)],
  // Each bearer field on its own still marks the request as token-based.
  ['a context carrying only apiKeyId', { apiKeyId: 7 }],
  ['a context carrying only subject', { subject: { type: 'apiKey', id: 7 } }],
  ['a context carrying only apiKeyType', { apiKeyType: 'System' }],
];

const procedures = [
  {
    name: 'add',
    call: (c: ReturnType<typeof createCaller>) => c.add({ name: 'k' }),
    handler: addApiKeyHandler,
    result: 'added',
  },
  {
    name: 'setBuzzLimit',
    call: (c: ReturnType<typeof createCaller>) => c.setBuzzLimit({ id: 9, buzzLimit: null }),
    handler: setBuzzLimitHandler,
    result: 'limited',
  },
  {
    name: 'delete',
    call: (c: ReturnType<typeof createCaller>) => c.delete({ id: 9 }),
    handler: deleteApiKeyHandler,
    result: 'deleted',
  },
];

beforeEach(() => vi.clearAllMocks());

describe.each(procedures)('apiKey.$name credential requirements', (procedure) => {
  it.each(allowed)('runs for %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).resolves.toBe(procedure.result);
    expect(procedure.handler).toHaveBeenCalledTimes(1);
  });

  it.each(refused)('refuses %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'This action requires a signed-in session or a full-access personal API key.',
      })
    );
    expect(procedure.handler).not.toHaveBeenCalled();
  });
});

describe('apiKey.setBuzzLimit on the calling key itself', () => {
  beforeEach(() => {
    dbMock.dbRead.apiKey.findFirst.mockReset();
    dbMock.dbRead.apiKey.findFirst.mockResolvedValue(null);
  });

  it('refuses a key changing its own limit', async () => {
    await expect(
      actualController.setBuzzLimitHandler({
        ctx: ctx(key('User', TokenScope.Full, 9)),
        input: { id: 9, buzzLimit: null },
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'A token cannot modify its own spend limit. Use a different key or session auth.',
      })
    );
    expect(dbMock.dbRead.apiKey.findFirst).not.toHaveBeenCalled();
  });

  // A missing key answers NOT_FOUND, which only comes after the self-modify check.
  it("lets a key change another key's limit", async () => {
    await expect(
      actualController.setBuzzLimitHandler({
        ctx: ctx(key('User', TokenScope.Full, 8)),
        input: { id: 9, buzzLimit: null },
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(dbMock.dbRead.apiKey.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('apiKey.setBuzzLimit on a developer docs key', () => {
  const docsKey = {
    id: 9,
    name: 'Developer docs (civitai.com)',
    type: 'User',
    expiresAt: new Date('2099-01-01'),
    tokenScope: DOCS_API_KEY_SCOPE,
    tokenScopeWide: null,
  };
  const wrote = new Error('update reached');
  beforeEach(() => {
    dbMock.dbRead.apiKey.findFirst.mockReset();
    dbMock.dbWrite.apiKey.update.mockReset();
    dbMock.dbWrite.apiKey.update.mockRejectedValue(wrote);
  });
  const setLimit = (
    buzzLimit: null | { type: 'sliding'; limit: number; window: 'day'; unit: number }[]
  ) => actualController.setBuzzLimitHandler({ ctx: ctx(), input: { id: 9, buzzLimit } });

  it.each([
    ['removed', null],
    ['raised', [{ type: 'sliding' as const, limit: 100_000, window: 'day' as const, unit: 1 }]],
  ])('refuses its limit being %s, writing nothing', async (_label, buzzLimit) => {
    dbMock.dbRead.apiKey.findFirst.mockResolvedValue(docsKey as never);
    await expect(setLimit(buzzLimit)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.apiKey.update).not.toHaveBeenCalled();
  });

  it('CONTROL: a personal key that only shares the docs name still changes', async () => {
    dbMock.dbRead.apiKey.findFirst.mockResolvedValue({ ...docsKey, expiresAt: null } as never);
    await expect(setLimit(null)).rejects.toBe(wrote);
  });
});

describe('apiKey.add during an impersonation', () => {
  it('creates no key while impersonating', async () => {
    const caller = createCaller(ctx({ impersonatedBy: 5 }));
    await expect(caller.add({ name: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: "API keys can't be created while impersonating",
    });
    expect(addApiKeyHandler).not.toHaveBeenCalled();
    // Control: the same session without the impersonation creates the key.
    await expect(createCaller(ctx()).add({ name: 'k' })).resolves.toBe('added');
  });
});
