import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

// A ban expires the user's generation token in the database; the cross-pod token cache must let go
// of it too, or after an unban every generation call hands the orchestrator a dead key for an hour.

const { getTemporaryUserApiKey } = vi.hoisted(() => ({ getTemporaryUserApiKey: vi.fn() }));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  getTemporaryUserApiKey,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));

const hash = new Map<string, string>();
vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: vi.fn(async (_client: unknown, _key: string, field: string, value: string) => {
    hash.set(field, value);
  }),
}));

const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');
const { encodeOwnedToken } = await import('~/server/orchestrator/orchestrator-token-identity');
const { expireUserApiKeys } = await import('~/server/services/api-key.service');

const USER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  hash.clear();
  perPodCache.clear();
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.sysRedis.hGet.mockImplementation(
    (async (_key: string, field: string) => hash.get(field) ?? null) as never
  );
  redisMock.sysRedis.hDel.mockImplementation((async (_key: string, field: string) =>
    Number(hash.delete(field))) as never);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([
    { id: 1, key: 'hashed-generation-token', expiresAt: new Date(Date.now() + 3_600_000) },
  ] as never);
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: 1 } as never);
  getTemporaryUserApiKey.mockResolvedValue('fresh-token');
  hash.set(String(USER), encodeOwnedToken(USER, 'token-from-before-the-ban'));
});

describe('the generation token after a ban', () => {
  it('is served from the cross-pod cache until then', async () => {
    await expect(getOrchestratorToken(USER)).resolves.toBe('token-from-before-the-ban');
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('is minted afresh by the next generation call after the ban is lifted', async () => {
    await expireUserApiKeys(USER);
    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
  });

  it('a cache failure does not stop the keys expiring', async () => {
    redisMock.sysRedis.hDel.mockRejectedValueOnce(new Error('sysRedis down') as never);
    await expect(expireUserApiKeys(USER)).resolves.toEqual({
      expired: 1,
      orchestratorConfirmed: true,
    });
  });

  it('a cache that never answers does not stall the ban', { timeout: 5_000 }, async () => {
    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 50 });
    redisMock.sysRedis.hDel.mockImplementationOnce((() => new Promise(() => undefined)) as never);
    await expect(expireUserApiKeys(USER)).resolves.toMatchObject({ expired: 1 });
  });
});
