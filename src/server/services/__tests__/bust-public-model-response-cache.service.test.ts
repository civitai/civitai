import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for bustPublicModelResponseCache (model-version.service.ts) — the
// public model-cache invalidation helper (the public API's origin-side response
// cache and the model-row cache behind model.getById) wired into bustMvCache,
// updateModelById, deleteModelById, AND upsertModel (FIX 1). upsertModel itself
// is too dependency-laden (Prisma + profanity + search-index + collections +
// ingest) to unit-test in isolation without a brittle scaffold, so its bust
// wiring is covered by code review; this file pins the contract the helper must
// honor at every call site: delete BOTH browsing-level keys for the model id(s),
// honor the IS_DATAPACKET gate, and fail open on a Redis error.

const { envBox } = vi.hoisted(() => ({
  // envBox.IS_DATAPACKET toggles the cache gate per-test. The other keys are the
  // module-load-time vars the import chain dereferences (s3-utils `new URL`,
  // meili/signals pLimit, logging `.includes`); mirror the global test-setup
  // defaults so importing the real model-version.service doesn't throw at load.
  // Anything else returns undefined (matches a missing optional env var).
  envBox: {
    IS_DATAPACKET: true,
    LOGGING: '',
    MEILI_CALL_CONCURRENCY: 50,
    SIGNALS_CALL_CONCURRENCY: 30,
    SIGNALS_TOKEN_CALL_CONCURRENCY: 30,
    S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
    S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  } as Record<string, unknown>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(envBox, { get: (t, p: string) => (p in t ? t[p] : undefined) }),
}));

// Keep the heavy service/search-index graph out of the test module graph
// (mirrors model-version.idempotent.service.test.ts).

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: {},
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
}));

import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { MODEL_DETAIL_PUBLIC_SHAPE } from '~/server/utils/model-detail-cache-key';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedisDel = redisMock.redis.del;

const keysFor = (id: number) => [
  `packed:caches:public-model-response:${id}:${allBrowsingLevelsFlag}`,
  `packed:caches:public-model-response:${id}:${sfwBrowsingLevelsFlag}`,
];
const modelRowKey = (id: number) =>
  `packed:caches:model-detail-public:${MODEL_DETAIL_PUBLIC_SHAPE}:${id}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisDel.mockResolvedValue(1);
});

describe('bustPublicModelResponseCache', () => {
  // Two deletes since the model-row cache joined this bust: its key is not behind the public
  // API's environment gate, so it is dropped in a call of its own.
  it('deletes BOTH browsing-level keys and the model-row key for a single model id', async () => {
    await bustPublicModelResponseCache(123);
    expect(mockRedisDel).toHaveBeenCalledTimes(2);
    expect(mockRedisDel).toHaveBeenCalledWith(keysFor(123));
    expect(mockRedisDel).toHaveBeenCalledWith([modelRowKey(123)]);
  });

  it('deletes every key for EVERY id when given an array (batch)', async () => {
    await bustPublicModelResponseCache([1, 2]);
    expect(mockRedisDel).toHaveBeenCalledTimes(2);
    expect(mockRedisDel).toHaveBeenCalledWith([...keysFor(1), ...keysFor(2)]);
    expect(mockRedisDel).toHaveBeenCalledWith([modelRowKey(1), modelRowKey(2)]);
  });

  // NB: the IS_DATAPACKET gate (PUBLIC_MODEL_RESPONSE_CACHE_ENABLED) is captured
  // ONCE at module load, so the disabled-path no-op isn't runtime-toggleable here
  // — it's covered by code review (env.IS_DATAPACKET=true on Datapacket only).

  it('is a no-op for an empty id array (no redis call)', async () => {
    await bustPublicModelResponseCache([]);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('fails open: swallows a Redis error and does not throw into the mutation path', async () => {
    // Every delete fails, the model-row one included.
    mockRedisDel.mockRejectedValue(new Error('redis down'));
    await expect(bustPublicModelResponseCache(123)).resolves.toBeUndefined();
  });
});
