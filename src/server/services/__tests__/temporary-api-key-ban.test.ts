import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as KeyGenerator from '~/server/utils/key-generator';

// Every orchestrator token is minted here, so this is where a banned account is refused one.

const { revokeCivitaiUserTokens } = vi.hoisted(() => ({
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens,
}));

// Hashing needs a secret that CI does not set; the hash itself is not under test.
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => `hash-of-${key}`,
}));

const { getTemporaryUserApiKey } = await import('~/server/services/api-key.service');
const { getOrchestratorToken } = await import('~/server/orchestrator/get-orchestrator-token');
const { __testing: perPodCache } = await import('~/server/orchestrator/orchestrator-token-cache');

const USER = 4242;
const mint = () =>
  getTemporaryUserApiKey({ name: 'generation-token', maxAge: 3605, type: 'System', userId: USER });
const standing = (bannedAt: Date | null, deletedAt: Date | null = null) =>
  ({ bannedAt, deletedAt } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.apiKey.create.mockResolvedValue({} as never);
  dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 0 } as never);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: 0 } as never);
  perPodCache.clear();
  envMock.set({ ORCHESTRATOR_MODE: 'prod' });
});

describe('minting an orchestrator token', () => {
  it('works for an account in good standing', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(null));
    await expect(mint()).resolves.toEqual(expect.any(String));
    expect(dbMock.dbWrite.apiKey.create).toHaveBeenCalledTimes(1);
  });

  it('is refused for a banned account, before any key is written', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(new Date()));
    const refused = await mint().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('FORBIDDEN');
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it('is refused for a deleted account', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(null, new Date()));
    await expect(mint()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it('reads the ban from the primary, not a replica', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(new Date()));
    dbMock.dbRead.user.findUnique.mockResolvedValue(standing(null));
    await expect(mint()).rejects.toThrow(TRPCError);
  });

  it('expires the key it just wrote when a ban lands while it mints', async () => {
    dbMock.dbWrite.user.findUnique
      .mockResolvedValueOnce(standing(null))
      .mockResolvedValueOnce(standing(new Date()));
    const justWritten = { id: 7, key: 'hashed', expiresAt: new Date(Date.now() + 3_600_000) };
    dbMock.dbWrite.apiKey.findMany.mockResolvedValue([justWritten] as never);

    await expect(mint()).rejects.toThrow(TRPCError);
    expect(dbMock.dbWrite.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
      data: { expiresAt: expect.any(Date) },
    });
    expect(revokeCivitaiUserTokens).toHaveBeenCalledWith({ userId: USER });
    // The account's earlier, expired generation keys are its record of the ban: not trimmed.
    expect(dbMock.dbWrite.apiKey.deleteMany).not.toHaveBeenCalled();
  });
});

describe('a ban landing mid-mint when the key cannot be expired', () => {
  it('still refuses with FORBIDDEN', async () => {
    dbMock.dbWrite.user.findUnique
      .mockResolvedValueOnce(standing(null))
      .mockResolvedValueOnce(standing(new Date()));
    dbMock.dbWrite.apiKey.findMany.mockRejectedValue(new Error('primary unavailable'));
    await expect(mint()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('an orchestrator token for a banned account', () => {
  // What every caller of getOrchestratorToken reaches once a ban has dropped the cached token,
  // including the routes that authenticate with a block token rather than a session.
  it('is refused, and nothing is cached', async () => {
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(new Date()));
    await expect(getOrchestratorToken(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
    expect(perPodCache.size().cache).toBe(0);
  });

  // A moderator listing a banned account's generations mints for that account, and is refused too:
  // the site would refuse the key at the orchestrator's identity check anyway.
  it('is refused on the cross-user path, with wording about that account', async () => {
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(new Date()));
    await expect(
      getOrchestratorToken(USER, undefined, { bypassCache: true })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This account has been banned',
    });
    expect(dbMock.dbWrite.apiKey.create).not.toHaveBeenCalled();
  });

  it('does not expire anything when the standing check itself fails', async () => {
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    dbMock.dbWrite.user.findUnique
      .mockResolvedValueOnce(standing(null))
      .mockRejectedValueOnce(new Error('primary unavailable'));
    dbMock.dbWrite.apiKey.findMany.mockResolvedValue([
      { id: 9, key: 'hashed', expiresAt: new Date(Date.now() + 3_600_000) },
    ] as never);
    await expect(getOrchestratorToken(USER)).rejects.toThrow('primary unavailable');
    expect(dbMock.dbWrite.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('is minted for an account in good standing', async () => {
    redisMock.sysRedis.hGet.mockResolvedValue(null as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(standing(null));
    await expect(getOrchestratorToken(USER)).resolves.toEqual(expect.any(String));
    expect(dbMock.dbWrite.apiKey.create).toHaveBeenCalledTimes(1);
  });
});
