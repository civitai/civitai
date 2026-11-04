import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ACCOUNT_META } from '@civitai/auth';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// The orchestrator token checks the caller's credential before either cache and before minting.

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
const WRITE_SCOPE = TokenScopePresets.ReadOnly | TokenScope.AIServicesWrite;
let meta: unknown = SYSTEM_ACCOUNT_META;

function keyCaller(tokenScope: number) {
  const req = {
    headers: { authorization: 'Bearer k' },
    context: {
      tokenScope,
      apiKeyId: 7,
      apiKeyType: ApiKeyType.User,
      subject: { type: 'apiKey', id: 7 },
    },
  } as unknown as NextApiRequest;
  return { req, res: {} as NextApiResponse };
}
const sessionCaller = () => ({
  req: { headers: {}, context: {} } as unknown as NextApiRequest,
  res: {} as NextApiResponse,
});

beforeEach(() => {
  vi.clearAllMocks();
  perPodCache.clear();
  meta = SYSTEM_ACCOUNT_META;
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
  redisMock.redis.packed.get.mockResolvedValue(null as never);
  dbMock.dbWrite.user.findUnique.mockImplementation((async () => ({
    muted: false,
    bannedAt: null,
    meta,
  })) as never);
  redisMock.sysRedis.hGet.mockResolvedValue(null as never);
  getTemporaryUserApiKey.mockResolvedValue('fresh-token');
});

describe('the orchestrator token for a system account', () => {
  it('is refused to a read-only key, without minting', async () => {
    await expect(
      getOrchestratorToken(USER, keyCaller(TokenScopePresets.ReadOnly))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('is refused to a read-only key when a token is already cached, without reading the cache', async () => {
    // Cached by an earlier call made with a write key.
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    await expect(getOrchestratorToken(USER, keyCaller(WRITE_SCOPE))).resolves.toBe('fresh-token');
    redisMock.sysRedis.hGet.mockResolvedValue(encodeOwnedToken(USER, 'cached-token') as never);
    await expect(getOrchestratorToken(USER, keyCaller(WRITE_SCOPE))).resolves.toBe('cached-token');
    redisMock.sysRedis.hGet.mockClear();
    getTemporaryUserApiKey.mockClear();

    await expect(
      getOrchestratorToken(USER, keyCaller(TokenScopePresets.ReadOnly))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(redisMock.sysRedis.hGet).not.toHaveBeenCalled();
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('is refused when the account cannot be read', async () => {
    // Standing answered from its cache, so only the account read fails.
    redisMock.redis.packed.get.mockResolvedValue({
      data: { muted: false, banned: false, exists: true },
      cachedAt: Date.now(),
    } as never);
    dbMock.dbWrite.user.findUnique.mockRejectedValue(new Error('db down') as never);
    await expect(
      getOrchestratorToken(USER, keyCaller(TokenScopePresets.ReadOnly))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getTemporaryUserApiKey).not.toHaveBeenCalled();
  });

  it('is refused when the account marker is stored as a string', async () => {
    meta = JSON.stringify(SYSTEM_ACCOUNT_META);
    await expect(
      getOrchestratorToken(USER, keyCaller(TokenScopePresets.ReadOnly))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('is issued to a key with AI Services write scope', async () => {
    await expect(getOrchestratorToken(USER, keyCaller(WRITE_SCOPE))).resolves.toBe('fresh-token');
  });

  it('is issued to a full-scope key', async () => {
    await expect(getOrchestratorToken(USER, keyCaller(TokenScope.Full))).resolves.toBe(
      'fresh-token'
    );
  });

  it('is issued to server-side calls with no request', async () => {
    await expect(getOrchestratorToken(USER)).resolves.toBe('fresh-token');
  });
});

describe('the orchestrator token for an ordinary account', () => {
  beforeEach(() => {
    meta = {};
  });

  it('is issued to a read-only key, so it can read its own work', async () => {
    await expect(getOrchestratorToken(USER, keyCaller(TokenScopePresets.ReadOnly))).resolves.toBe(
      'fresh-token'
    );
  });

  it('is issued to a session', async () => {
    await expect(getOrchestratorToken(USER, sessionCaller())).resolves.toBe('fresh-token');
  });
});
