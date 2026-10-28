import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { hSetWithTTL } = vi.hoisted(() => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL }));

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
  hSetWithTTL.mockImplementation(
    async (_client: unknown, _key: string, field: string, value: string) => {
      hash.set(field, value);
    }
  );
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

describe('a per-pod cached token after a ban', () => {
  // This pod minted the user's token shortly before the ban, so its per-pod cache still holds it.
  async function mintOnThisPod() {
    hash.clear();
    getTemporaryUserApiKey.mockResolvedValueOnce('token-from-before-the-ban');
    await expect(getOrchestratorToken(USER)).resolves.toBe('token-from-before-the-ban');
    getTemporaryUserApiKey.mockClear();
  }

  it('once the account is in good standing again, the next call on that pod gets a fresh token', async () => {
    await mintOnThisPod();
    await expireUserApiKeys(USER);

    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
    expect(hash.get(String(USER))).toBe(encodeOwnedToken(USER, 'fresh-token'));
  });

  it('is never written back to the cross-pod cache', async () => {
    await mintOnThisPod();
    await expireUserApiKeys(USER);
    // sysRedis cannot answer the read but takes the write: the per-pod entry is served...
    redisMock.sysRedis.hGet.mockRejectedValueOnce(new Error('sysRedis read failed') as never);
    await expect(getOrchestratorToken(USER)).resolves.toBe('token-from-before-the-ban');
    // ...and every other pod still finds nothing, so it mints.
    expect(hash.has(String(USER))).toBe(false);
  });

  it('still spares the database while sysRedis is down', async () => {
    await mintOnThisPod();
    redisMock.sysRedis.hGet.mockRejectedValue(new Error('sysRedis down') as never);
    await getOrchestratorToken(USER);
    await getOrchestratorToken(USER);
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });
});

describe('while sysRedis takes reads but refuses writes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the per-pod cache instead of minting on every call', async () => {
    hash.clear();
    hSetWithTTL.mockRejectedValue(new Error('OOM command not allowed'));
    await getOrchestratorToken(USER);
    await getOrchestratorToken(USER);
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(1);
  });

  it('goes back to the hash once writes have worked for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    hash.clear();
    hSetWithTTL.mockRejectedValueOnce(new Error('OOM command not allowed'));
    await getOrchestratorToken(USER);
    vi.setSystemTime(Date.now() + 61_000);
    // The per-pod entry is still live (its TTL runs on a monotonic clock), but no longer served.
    await getOrchestratorToken(USER);
    expect(getTemporaryUserApiKey).toHaveBeenCalledTimes(2);
  });
});
