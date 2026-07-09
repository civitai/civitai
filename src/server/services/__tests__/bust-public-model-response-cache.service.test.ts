import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for bustPublicModelResponseCache (model-version.service.ts) — the
// origin-side response-cache invalidation helper wired into bustMvCache,
// updateModelById, deleteModelById, AND upsertModel (FIX 1). upsertModel itself
// is too dependency-laden (Prisma + profanity + search-index + collections +
// ingest) to unit-test in isolation without a brittle scaffold, so its bust
// wiring is covered by code review; this file pins the contract the helper must
// honor at every call site: delete BOTH browsing-level keys for the model id(s),
// honor the IS_DATAPACKET gate, and fail open on a Redis error.

const { mockRedisDel, envBox } = vi.hoisted(() => ({
  mockRedisDel: vi.fn(),
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
    S3_UPLOAD_ENDPOINT: 'http://localhost:9000',
    S3_IMAGE_UPLOAD_ENDPOINT: 'http://localhost:9000',
  } as Record<string, unknown>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(envBox, { get: (t, p: string) => (p in t ? t[p] : undefined) }),
}));
vi.mock('~/server/redis/client', () => ({
  redis: { del: mockRedisDel },
  REDIS_KEYS: { CACHES: { PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response' } },
}));

// Keep the heavy service/search-index graph out of the test module graph
// (mirrors model-version.idempotent.service.test.ts).
const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });
  return {
    mockDbRead: { modelVersion: mk(), donationGoal: mk(), model: mk(), $queryRaw: vi.fn() },
    mockDbWrite: {
      modelVersion: mk(),
      modelVersionEngagement: mk(),
      model: mk(),
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
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
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ filesForModelVersionCache: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const keysFor = (id: number) => [
  `packed:caches:public-model-response:${id}:${allBrowsingLevelsFlag}`,
  `packed:caches:public-model-response:${id}:${sfwBrowsingLevelsFlag}`,
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisDel.mockResolvedValue(1);
});

describe('bustPublicModelResponseCache', () => {
  it('deletes BOTH browsing-level keys for a single model id', async () => {
    await bustPublicModelResponseCache(123);
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith(keysFor(123));
  });

  it('deletes BOTH keys for EVERY id when given an array (batch)', async () => {
    await bustPublicModelResponseCache([1, 2]);
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith([...keysFor(1), ...keysFor(2)]);
  });

  // NB: the IS_DATAPACKET gate (PUBLIC_MODEL_RESPONSE_CACHE_ENABLED) is captured
  // ONCE at module load, so the disabled-path no-op isn't runtime-toggleable here
  // — it's covered by code review (env.IS_DATAPACKET=true on Datapacket only).

  it('is a no-op for an empty id array (no redis call)', async () => {
    await bustPublicModelResponseCache([]);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('fails open: swallows a Redis error and does not throw into the mutation path', async () => {
    mockRedisDel.mockRejectedValueOnce(new Error('redis down'));
    await expect(bustPublicModelResponseCache(123)).resolves.toBeUndefined();
  });
});
