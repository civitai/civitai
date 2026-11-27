import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { TokenScopePresets } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// A personal API key with a Buzz limit, used by its own user, reaches the orchestrator as itself
// (flag `user-key-buzz-limit-proxy`), so the orchestrator holds the work to that key's limit. Every
// other caller still gets the user's System token.

const { getTemporaryUserApiKey, flags } = vi.hoisted(() => ({
  getTemporaryUserApiKey: vi.fn(),
  flags: { userKey: true, offlineGrant: false },
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  getTemporaryUserApiKey,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (key: string) =>
      key === actual.FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY
        ? flags.userKey
        : key === actual.FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT
        ? flags.offlineGrant
        : false
    ),
  };
});

// The Training Studio host route, with its session and access gates passed, so only the token it
// hands back is under test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (...args: unknown[]) => unknown) => (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, { id: 4242 }, { user: { id: 4242 } }),
}));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: async () => true }));
vi.mock('~/server/auth/refuse-while-impersonating', () => ({
  refuseWhileImpersonating: () => false,
}));

const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const trainingStudioHost = (await import('~/pages/api/training-studio/host'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');

const USER = 4242;
const KEY = 'civitai_personal-key-value';
const LIMIT = [{ type: 'sliding', limit: 500, window: 'day', unit: 1 }];

function keyCaller(
  opts: { buzzLimit?: unknown; sessionUserId?: number; apiKeyType?: ApiKeyType } = {}
) {
  const req = {
    url: '/api/trpc/orchestrator.generateFromGraph',
    headers: { authorization: `Bearer ${KEY}` },
    context: {
      session: { user: { id: opts.sessionUserId ?? USER, meta: {} } },
      tokenScope: TokenScopePresets.Full,
      apiKeyId: 7,
      apiKeyType: opts.apiKeyType ?? ApiKeyType.User,
      subject: { type: 'apiKey', id: 7 },
      buzzLimit: 'buzzLimit' in opts ? opts.buzzLimit : LIMIT,
    },
  } as unknown as NextApiRequest;
  return { req, res: {} as NextApiResponse };
}
const sessionCaller = () => ({
  req: {
    headers: {},
    context: { session: { user: { id: USER, meta: {} } } },
  } as unknown as NextApiRequest,
  res: {} as NextApiResponse,
});

beforeEach(() => {
  vi.clearAllMocks();
  perPodCache.clear();
  flags.userKey = true;
  flags.offlineGrant = false;
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.redis.packed.get.mockResolvedValue({
    data: { muted: false, banned: false, exists: true },
    cachedAt: Date.now(),
  } as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    muted: false,
    bannedAt: null,
    meta: {},
  } as never);
  redisMock.sysRedis.hGet.mockResolvedValue(null as never);
  getTemporaryUserApiKey.mockResolvedValue('system-token');
});

describe('a limited personal key with the flag on', () => {
  it.each([
    ['the offline-grant flag off', false],
    ['the offline-grant flag on', true],
  ])(
    'is sent as itself, with %s, and the System token is never minted or read',
    async (_, offlineGrant) => {
      flags.offlineGrant = offlineGrant;
      await expect(getOrchestratorToken(USER, keyCaller())).resolves.toBe(KEY);
      expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.hGet).not.toHaveBeenCalled();
    }
  );

  it('is not cached, so the next session call still gets the System token', async () => {
    await getOrchestratorToken(USER, keyCaller());
    await expect(getOrchestratorToken(USER, sessionCaller())).resolves.toBe('system-token');
  });
});

describe('every other caller still gets the System token', () => {
  it.each([
    ['the flag off', () => ((flags.userKey = false), keyCaller())],
    ['a key with no limit', () => keyCaller({ buzzLimit: null })],
    ['a key with an empty limit', () => keyCaller({ buzzLimit: [] })],
    ['a session cookie', () => sessionCaller()],
    ['a moderator fetching another user’s token', () => keyCaller({ sessionUserId: 1 })],
    ['a System key', () => keyCaller({ apiKeyType: ApiKeyType.System })],
  ])('%s', async (_, caller) => {
    await expect(getOrchestratorToken(USER, caller())).resolves.toBe('system-token');
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
  });

  it('a server-side call with no request', async () => {
    await expect(getOrchestratorToken(USER)).resolves.toBe('system-token');
  });
});

it('in ORCHESTRATOR_MODE=dev a limited key gets the dev token, as before', async () => {
  envMock.set({ ORCHESTRATOR_MODE: 'dev', ORCHESTRATOR_ACCESS_TOKEN: 'dev-token' });
  await expect(getOrchestratorToken(USER, keyCaller())).resolves.toBe('dev-token');
});

describe('the Training Studio host', () => {
  const hostToken = async (caller: { req: NextApiRequest }) => {
    let body: unknown;
    const res = {
      setHeader: () => res,
      status: () => res,
      json: (b: unknown) => (body = b),
    } as unknown as NextApiResponse;
    await trainingStudioHost(caller.req, res);
    return (body as { token?: string }).token;
  };

  it('hands a limited personal key back as the token, with the flag on', async () => {
    await expect(hostToken(keyCaller())).resolves.toBe(KEY);
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('hands back the System token with the flag off', async () => {
    flags.userKey = false;
    await expect(hostToken(keyCaller())).resolves.toBe('system-token');
  });
});
