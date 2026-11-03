import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import { REDIS_KEYS } from '~/server/redis/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A mute expires the generation key; after the unmute the next generation call mints a new one
// rather than serving the expired key from a cache, so the account recovers without help.

const { getTemporaryUserApiKey } = vi.hoisted(() => ({ getTemporaryUserApiKey: vi.fn() }));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  getTemporaryUserApiKey,
}));
vi.mock('~/server/auth/session-cache', () => ({ clearSessionCache: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));
const tokensOwned = new Map<string, string>();
vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: vi.fn(async (_client: unknown, key: string, field: string, value: string) => {
    if (key === REDIS_KEYS.GENERATION.TOKENS_OWNED) tokensOwned.set(field, value);
  }),
}));

const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');
const { encodeOwnedToken } = await import('~/server/orchestrator/orchestrator-token-identity');
const { afterAccountStandingChanged } = await import('~/server/services/account-standing.service');

const USER = 4243;
const systemKey = {
  id: 1,
  key: 'old-key-hash',
  type: 'System',
  tokenScope: TokenScope.Full,
  expiresAt: new Date(Date.now() + 3_600_000),
};
let muted = false;

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  perPodCache.clear();
  tokensOwned.clear();
  tokensOwned.set(String(USER), encodeOwnedToken(USER, 'old-token') as string);
  muted = false;
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  dbMock.dbWrite.user.findUnique.mockImplementation((async () => ({
    muted,
    bannedAt: null,
  })) as never);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([systemKey] as never);
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: 1 } as never);
  redisMock.sysRedis.hGet.mockImplementation((async (key: string, field: string) =>
    key === REDIS_KEYS.GENERATION.TOKENS_OWNED ? tokensOwned.get(field) ?? null : null) as never);
  redisMock.sysRedis.hDel.mockImplementation((async (key: string, field: string) =>
    key === REDIS_KEYS.GENERATION.TOKENS_OWNED && tokensOwned.delete(field) ? 1 : 0) as never);
  getTemporaryUserApiKey.mockResolvedValue('fresh-token');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('the generation token across a mute and an unmute', () => {
  it('is expired by the mute and minted afresh on the first call after the unmute', async () => {
    await expect(getOrchestratorToken(USER)).resolves.toBe('old-token');

    muted = true;
    await afterAccountStandingChanged(USER, { kind: 'invalidate', caller: 'moderation' });
    expect(dbMock.dbWrite.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [systemKey.id] } } })
    );
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    muted = false;
    await afterAccountStandingChanged(USER, { kind: 'invalidate', caller: 'moderation' });
    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
    expect(getTemporaryUserApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, type: 'System' })
    );

    // The fresh key is what later calls are served, not a second mint.
    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
  });
});
