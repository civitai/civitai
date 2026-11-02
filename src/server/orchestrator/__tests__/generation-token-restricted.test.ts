import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';

// A restricted account gets no generation token: not a fresh one and not one cached from before the
// restriction. Server-side reads of its own work (and a moderator's) still get one.

const { getTemporaryUserApiKey } = vi.hoisted(() => ({ getTemporaryUserApiKey: vi.fn() }));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  getTemporaryUserApiKey,
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));

const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');
const { encodeOwnedToken } = await import('~/server/orchestrator/orchestrator-token-identity');

const USER = 4242;
let muted = false;
let bannedAt: Date | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  perPodCache.clear();
  muted = false;
  bannedAt = null;
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.redis.packed.get.mockResolvedValue(null as never);
  dbMock.dbWrite.user.findUnique.mockImplementation((async () => ({ muted, bannedAt })) as never);
  redisMock.sysRedis.hGet.mockResolvedValue(encodeOwnedToken(USER, 'cached-token') as never);
  getTemporaryUserApiKey.mockResolvedValue('fresh-token');
});

describe('the generation token for a restricted account', () => {
  it('an account in good standing gets its cached token', async () => {
    await expect(getOrchestratorToken(USER)).resolves.toBe('cached-token');
  });

  it('an account in good standing gets a fresh one on a miss', async () => {
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
  });

  it('a muted account is refused, though a token from before the mute is cached', async () => {
    muted = true;
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('a banned account is refused, though a token is cached', async () => {
    bannedAt = new Date();
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an account with no row is refused', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null as never);
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a muted account is refused on a miss too, without minting', async () => {
    muted = true;
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('reads the standing from its cache, not the database, when the cache holds it', async () => {
    redisMock.redis.packed.get.mockResolvedValue({
      data: { muted: true, banned: false, exists: true },
      cachedAt: Date.now(),
    } as never);
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    redisMock.redis.packed.get.mockResolvedValue({
      data: { muted: false, banned: false, exists: true },
      cachedAt: Date.now(),
    } as never);
    await expect(getOrchestratorToken(USER)).resolves.toBe('cached-token');
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('is refused when neither the standing cache nor the database answers', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('redis down') as never);
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down') as never);
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is still issued when only the standing cache is down', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('redis down') as never);
    await expect(getOrchestratorToken(USER)).resolves.toBe('cached-token');
  });

  it('a muted account still gets one for server-side reads of its own work', async () => {
    muted = true;
    await expect(getOrchestratorToken(USER, undefined, { allowRestricted: true })).resolves.toBe(
      'cached-token'
    );
  });

  it('a banned account is refused even where a muted one is admitted', async () => {
    bannedAt = new Date();
    await expect(
      getOrchestratorToken(USER, undefined, { bypassCache: true, allowRestricted: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'This account has been banned' });
  });

  it('a moderator still reads a muted account’s work', async () => {
    muted = true;
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    await expect(
      getOrchestratorToken(USER, undefined, { bypassCache: true, allowRestricted: true })
    ).resolves.toBe('fresh-token');
  });
});
