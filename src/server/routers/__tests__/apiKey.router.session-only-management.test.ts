import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiKeyController from '~/server/controllers/api-key.controller';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Handlers are stubbed so only the router's middleware chain is under test.
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
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
    ...credential,
  } as never;
}

const bearers: [string, Record<string, unknown>][] = [
  ['a full-scope User key', { apiKeyId: 1, subject: { type: 'apiKey', id: 1 } }],
  ['a full-scope System key', { apiKeyId: 2, subject: { type: 'apiKey', id: 2 } }],
  ['a full-scope OAuth access token', { apiKeyId: 3, subject: { type: 'oauth', id: 'c' } }],
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

describe.each(procedures)('apiKey.$name requires a browser session', (procedure) => {
  it('runs for a browser session', async () => {
    await expect(procedure.call(createCaller(ctx()))).resolves.toBe(procedure.result);
    expect(procedure.handler).toHaveBeenCalledTimes(1);
  });

  it.each(bearers)('refuses %s', async (_label, credential) => {
    await expect(procedure.call(createCaller(ctx(credential)))).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'This action cannot be performed via API key or OAuth token.',
      })
    );
    expect(procedure.handler).not.toHaveBeenCalled();
  });
});
