import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DownloadLinkStore from '~/server/services/download-link/download-link.store';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as PrincipalCache from '~/server/auth/api-key-principal-cache';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Revoking an API key, by every path that revokes one, ends every review batch that key minted (held
 * ones included) and no batch another key minted. The key paths run for real; their database reads
 * and the side calls beside the batch revoke are faked.
 */

vi.mock('~/server/auth/api-key-principal-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof PrincipalCache>()),
  evictCachedApiKeys: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  revokeCivitaiUserTokens: vi.fn(async () => true),
}));
vi.mock('~/server/services/download-link/download-link.store', async (importOriginal) => ({
  ...(await importOriginal<typeof DownloadLinkStore>()),
  revokeLinksOfRevokedCredentials: vi.fn(async () => undefined),
}));

const { deleteApiKeys, expireUserApiKeys } = await import('~/server/services/api-key.service');

let store = new Map<string, string | Set<string>>();

function installFakeSysRedis() {
  store = new Map();
  const r = redisMock.sysRedis;
  r.get.mockImplementation(async (key: string) => {
    const v = store.get(key);
    return typeof v === 'string' ? v : null;
  });
  r.sMembers.mockImplementation(async (key: string) => {
    const v = store.get(key);
    return v instanceof Set ? [...v] : [];
  });
  r.del.mockImplementation(async (keys: string | string[]) => {
    for (const key of [keys].flat()) store.delete(key);
    return 1;
  });
}

/** A live batch minted by `keyId`, as the mint stores it. */
function seedBatch(hash: string, keyId: number, tier: 'general' | 'held') {
  store.set(`app:review-batch:${hash}`, JSON.stringify({ ids: [1], tier, keyId }));
  const set = (store.get(`app:review-batch-key:${keyId}`) as Set<string>) ?? new Set<string>();
  set.add(hash);
  store.set(`app:review-batch-key:${keyId}`, set);
}

const live = () => [...store.keys()].filter((k) => /^app:review-batch:[^:]+$/.test(k)).sort();

beforeEach(() => {
  installFakeSysRedis();
  seedBatch('held-1', 99, 'held');
  seedBatch('general-1', 99, 'general');
  seedBatch('other-key', 100, 'held');
  dbMock.dbWrite.apiKey.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.apiKey.updateMany.mockResolvedValue({ count: 1 });
});

describe('revoking an API key ends the review batches it minted', () => {
  it('deleting the key', async () => {
    dbMock.dbWrite.apiKey.findMany.mockResolvedValue([{ id: 99, key: 'hash-99', userId: 7 }]);
    await deleteApiKeys({ id: 99 });
    expect(live()).toEqual(['app:review-batch:other-key']);
  });

  it("expiring the user's keys", async () => {
    dbMock.dbWrite.apiKey.findMany.mockResolvedValue([{ id: 99, key: 'hash-99', expiresAt: null }]);
    await expireUserApiKeys(7);
    expect(live()).toEqual(['app:review-batch:other-key']);
  });
});
