import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';
import { TokenScopePresets } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// A personal API key with a Buzz limit, used by its own user, reaches the orchestrator as itself
// (flag `user-key-buzz-limit-proxy`), so the orchestrator holds the work to that key's limit. Every
// other caller still gets a System token, minted here through the real mint against the db mock.

const h = vi.hoisted(() => {
  // The real mint hashes the new key.
  process.env.NEXTAUTH_SECRET = 'own-key-test-secret-0123456789';
  return { flags: { userKey: true, offlineGrant: false }, mintOrigin: 'refresh' as string | null };
});
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: vi.fn(async (key: string) =>
      key === actual.FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY
        ? h.flags.userKey
        : key === actual.FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT
        ? h.flags.offlineGrant
        : false
    ),
  };
});
vi.mock('~/server/db/kyselyDb', () => {
  const qb = {
    select: () => qb,
    where: () => qb,
    executeTakeFirst: async () => ({ mintOrigin: h.mintOrigin }),
  };
  return { kyselyWrite: { selectFrom: () => qb } };
});

const { callerOwnOrchestratorToken, getOrchestratorToken } = await import(
  '~/server/orchestrator/get-orchestrator-token'
);
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');

const USER = 4242;
const KEY = 'civitai_personal-key-value';
const LIMIT = [{ type: 'sliding', limit: 500, window: 'day', unit: 1 }];
const credentials = {
  personal: { apiKeyId: 7, apiKeyType: ApiKeyType.User, subject: { type: 'apiKey', id: 7 } },
  oauth: { apiKeyId: 9, apiKeyType: ApiKeyType.Access, subject: { type: 'oauth', id: 'app' } },
};

function keyCaller(
  opts: {
    buzzLimit?: unknown;
    sessionUserId?: number;
    apiKeyType?: ApiKeyType;
    credential?: keyof typeof credentials;
  } = {}
) {
  const req = {
    url: '/api/trpc/orchestrator.generateFromGraph',
    headers: { authorization: `Bearer ${KEY}` },
    context: {
      session: { user: { id: opts.sessionUserId ?? USER, meta: {} } },
      tokenScope: TokenScopePresets.Full,
      ...credentials[opts.credential ?? 'personal'],
      ...(opts.apiKeyType ? { apiKeyType: opts.apiKeyType } : {}),
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
const minted = () => dbMock.dbWrite.apiKey.create.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  perPodCache.clear();
  h.flags = { userKey: true, offlineGrant: false };
  h.mintOrigin = 'refresh';
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.redis.packed.get.mockResolvedValue({
    data: { muted: false, banned: false, exists: true },
    cachedAt: Date.now(),
  } as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    muted: false,
    bannedAt: null,
    deletedAt: null,
    meta: {},
  } as never);
  dbMock.dbWrite.apiKey.create.mockResolvedValue({} as never);
  dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 0 } as never);
  redisMock.sysRedis.hGet.mockResolvedValue(null as never);
});

describe('a limited personal key with the flag on', () => {
  it.each([
    ['the offline-grant flag off', false],
    ['the offline-grant flag on', true],
  ])(
    'is sent as itself, with %s, and no System token is minted or read',
    async (_, offlineGrant) => {
      h.flags.offlineGrant = offlineGrant;
      await expect(getOrchestratorToken(USER, keyCaller())).resolves.toBe(KEY);
      expect(minted()).toBe(0);
      expect(redisMock.sysRedis.hGet).not.toHaveBeenCalled();
    }
  );

  it('is not cached, so the next session call still gets a System token', async () => {
    await getOrchestratorToken(USER, keyCaller());
    const token = await getOrchestratorToken(USER, sessionCaller());
    expect(token).not.toBe(KEY);
    expect(minted()).toBe(1);
  });
});

describe('every other caller still gets a System token', () => {
  it.each([
    ['the flag off', () => ((h.flags.userKey = false), keyCaller())],
    ['a key with no limit', () => keyCaller({ buzzLimit: null })],
    ['a key with an empty limit', () => keyCaller({ buzzLimit: [] })],
    ['a session cookie', () => sessionCaller()],
    ['a moderator fetching another user’s token', () => keyCaller({ sessionUserId: 1 })],
    ['a System key', () => keyCaller({ apiKeyType: ApiKeyType.System })],
  ])('%s', async (_, caller) => {
    const token = await getOrchestratorToken(USER, caller());
    expect(token).not.toBe(KEY);
    expect(minted()).toBe(1);
  });

  it('a server-side call with no request', async () => {
    await expect(getOrchestratorToken(USER)).resolves.not.toBe(KEY);
    expect(minted()).toBe(1);
  });
});

it('in ORCHESTRATOR_MODE=dev a limited key gets the dev token, as before', async () => {
  envMock.set({ ORCHESTRATOR_MODE: 'dev', ORCHESTRATOR_ACCESS_TOKEN: 'dev-token' });
  await expect(getOrchestratorToken(USER, keyCaller())).resolves.toBe('dev-token');
});

// The predicate a path that queues work asks (comics smartCreateChapter): each case follows its own flag.
describe('callerOwnOrchestratorToken', () => {
  it.each([
    ['personal', { userKey: true, offlineGrant: false }, KEY],
    ['personal', { userKey: false, offlineGrant: true }, null],
    ['oauth', { userKey: false, offlineGrant: true }, KEY],
    ['oauth', { userKey: true, offlineGrant: false }, null],
  ] as const)('%s key with flags %o: %s', async (credential, flags, expected) => {
    h.flags = { ...flags };
    await expect(callerOwnOrchestratorToken(USER, keyCaller({ credential }).req)).resolves.toBe(
      expected
    );
  });

  it('is null for an OAuth token not minted from a refresh grant', async () => {
    h.flags = { userKey: true, offlineGrant: true };
    h.mintOrigin = 'auth_code';
    await expect(
      callerOwnOrchestratorToken(USER, keyCaller({ credential: 'oauth' }).req)
    ).resolves.toBeNull();
  });

  it('is null in ORCHESTRATOR_MODE=dev', async () => {
    envMock.set({ ORCHESTRATOR_MODE: 'dev' });
    await expect(callerOwnOrchestratorToken(USER, keyCaller().req)).resolves.toBeNull();
  });
});
