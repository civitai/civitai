import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import { REDIS_KEYS } from '~/server/redis/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// A mute ends the generation credentials already issued, so none of them outlives it. App tokens
// without an AI Services scope, personal keys and the site session are left alone.

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

const { afterAccountStandingChanged } = await import('~/server/services/account-standing.service');

const USER = 42;
const MUTE = { kind: 'invalidate', caller: 'moderation' } as const;
const live = new Date(Date.now() + 3_600_000);
const rows = [
  { id: 1, key: 'k1', type: 'System', tokenScope: TokenScope.Full, expiresAt: live },
  { id: 2, key: 'k2', type: 'Access', tokenScope: TokenScope.AIServicesWrite, expiresAt: live },
  { id: 3, key: 'k3', type: 'Refresh', tokenScope: TokenScope.AIServicesRead, expiresAt: live },
  { id: 4, key: 'k4', type: 'Access', tokenScope: TokenScope.ModelsRead, expiresAt: live },
  { id: 5, key: 'k5', type: 'User', tokenScope: TokenScope.AIServicesWrite, expiresAt: null },
  { id: 6, key: 'k6', type: 'System', tokenScope: TokenScope.Full, expiresAt: null },
];
const expiredIds = () =>
  dbMock.dbWrite.apiKey.updateMany.mock.calls.flatMap(
    ([args]) => (args as { where: { id: { in: number[] } } }).where.id.in
  );

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue(rows as never);
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: 0 } as never);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('a mute and the generation credentials already issued', () => {
  it('expires the generation key and AI Services app tokens, and drops the cached token', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    await afterAccountStandingChanged(USER, MUTE);
    expect(expiredIds().sort()).toEqual([1, 2, 3, 6]);
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith(
      REDIS_KEYS.GENERATION.TOKENS_OWNED,
      String(USER)
    );
  });

  it('expires them again after the standing cache settles, catching a key minted in between', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: true } as never);
    await afterAccountStandingChanged(USER, MUTE);
    dbMock.dbWrite.apiKey.updateMany.mockClear();
    await vi.runAllTimersAsync();
    expect(expiredIds().sort()).toEqual([1, 2, 3, 6]);
  });

  it('leaves them alone on an unmute', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false } as never);
    await afterAccountStandingChanged(USER, MUTE);
    expect(dbMock.dbWrite.apiKey.updateMany).not.toHaveBeenCalled();
  });
});
