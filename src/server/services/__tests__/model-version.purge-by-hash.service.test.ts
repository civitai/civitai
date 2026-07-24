import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies the by-hash edge-cache purge hook: on delete AND unpublish, the
// service purges the `GET /api/v1/model-versions/by-hash/[hash]` PublicEndpoint
// (edge-cached, no Cache-Tag) by exact URL so a taken-down version stops
// resolving by-hash before the cache TTL expires. The purge is best-effort — a
// purge failure must NOT fail the (already-committed) mutation.

const { mockDb } = vi.hoisted(() => {
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
  const db = {
    modelVersion: mk(),
    modelFile: mk(),
    modelFileHash: mk(),
    entityAccess: mk(),
    post: mk(),
    image: mk(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockDb: db };
});

const { mockPurgeCache } = vi.hoisted(() => ({ mockPurgeCache: vi.fn() }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: mockPurgeCache }));
vi.mock('~/server/utils/url-helpers', () => ({
  getBaseUrl: () => 'https://civitai.com',
  getInternalUrl: () => 'http://localhost:3000',
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});

// Keep the heavy service/search-index graph out of the test module graph
// (mirrors model-version.deregister.service.test.ts). Cache stubs carry no-op
// async methods so bustMvCache — which is awaited un-guarded on the unpublish
// path — runs cleanly rather than throwing.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
  modelVersionPublicDonationGoalsCache: {},
  modelVersionResourceCache: {},
}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>(
    '@civitai/redis/client'
  );
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
    sysRedis: { get: vi.fn() },
  };
});
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  // publish runs `ingestModelById(...).catch(...)` fire-and-forget, so the mock
  // must return a promise.
  ingestModelById: vi.fn().mockResolvedValue(undefined),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  filesForModelVersionCache: {},
  findOfficialFileByHash: vi.fn(),
  markFileReplaced: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, preventModelVersionLag: vi.fn() };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteModelFileObjects: vi.fn() };
});
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocations: vi.fn() }));

import {
  deleteVersionById,
  publishModelVersionById,
  unpublishModelVersionById,
} from '~/server/services/model-version.service';

// Drive the interactive transaction: invoke the callback with a `tx` that maps
// to our mocked db delegates.
function wireTransaction() {
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockDb)
  );
}

const VERSION_ID = 4242;
const MODEL_ID = 7;
const USER_ID = 99;

beforeEach(() => {
  vi.clearAllMocks();
  wireTransaction();
  mockPurgeCache.mockResolvedValue(undefined);
});

function stubDeleteRows(files: { url: string; hashes: string[] }[]) {
  mockDb.modelFile.findMany.mockResolvedValue(
    files.map((f) => ({ url: f.url, hashes: f.hashes.map((hash) => ({ hash })) }))
  );
  mockDb.modelVersion.findFirstOrThrow.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    status: 'Published',
    earlyAccessConfig: null,
    earlyAccessEndsAt: null,
    meta: {},
  });
  mockDb.entityAccess.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.modelVersion.delete.mockResolvedValue({ id: VERSION_ID, modelId: MODEL_ID });
}

describe('deleteVersionById — by-hash edge-cache purge', () => {
  it('purges the exact by-hash URL(s) (upper + lower case) for the deleted version', async () => {
    stubDeleteRows([{ url: 'https://b2/model/7/a.safetensors', hashes: ['ABC123'] }]);

    await deleteVersionById({ id: VERSION_ID });

    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
    const arg = mockPurgeCache.mock.calls[0][0] as { urls: string[] };
    expect(new Set(arg.urls)).toEqual(
      new Set([
        'https://civitai.com/api/v1/model-versions/by-hash/ABC123',
        'https://civitai.com/api/v1/model-versions/by-hash/abc123',
      ])
    );
  });

  it('purges every hash across every file of the version, deduped', async () => {
    stubDeleteRows([
      { url: 'https://b2/model/7/a.safetensors', hashes: ['AAAA', 'BBBB'] },
      { url: 'https://b2/model/7/b.yaml', hashes: ['AAAA'] }, // duplicate hash → deduped
    ]);

    await deleteVersionById({ id: VERSION_ID });

    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
    const arg = mockPurgeCache.mock.calls[0][0] as { urls: string[] };
    // 2 unique hashes × 2 casings = 4 urls, no dupes.
    expect(arg.urls).toHaveLength(4);
    expect(new Set(arg.urls)).toEqual(
      new Set([
        'https://civitai.com/api/v1/model-versions/by-hash/AAAA',
        'https://civitai.com/api/v1/model-versions/by-hash/aaaa',
        'https://civitai.com/api/v1/model-versions/by-hash/BBBB',
        'https://civitai.com/api/v1/model-versions/by-hash/bbbb',
      ])
    );
  });

  it('does not purge when the version has no file hashes', async () => {
    stubDeleteRows([{ url: 'https://b2/model/7/a.safetensors', hashes: [] }]);

    await deleteVersionById({ id: VERSION_ID });

    expect(mockPurgeCache).not.toHaveBeenCalled();
  });

  // Defensive guard test: post-fix, purgeCache swallows Cloudflare failures
  // internally (see client.purgeCache.test.ts), so a real CF error no longer
  // rejects to this caller. This still guards the caller against the by-hash
  // helper throwing for any OTHER reason (getBaseUrl, hash resolution, etc.) —
  // a purge-path throw must never fail the already-committed delete.
  it('does not fail the delete if the purge throws (best-effort)', async () => {
    stubDeleteRows([{ url: 'https://b2/model/7/a.safetensors', hashes: ['ABC123'] }]);
    mockPurgeCache.mockRejectedValue(new Error('cloudflare down'));

    const result = await deleteVersionById({ id: VERSION_ID });

    expect(result).toEqual({ id: VERSION_ID, modelId: MODEL_ID });
    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
  });
});

describe('unpublishModelVersionById — by-hash edge-cache purge', () => {
  function stubUnpublish() {
    mockDb.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      model: { id: MODEL_ID, userId: USER_ID, nsfw: false },
    });
    mockDb.$executeRaw.mockResolvedValue(0);
    mockDb.post.findMany.mockResolvedValue([]);
    mockDb.image.findMany.mockResolvedValue([]);
    // Rows still exist on unpublish — resolved by-hash via modelFileHash.findMany.
    mockDb.modelFileHash.findMany.mockResolvedValue([{ hash: 'DEADBEEF' }]);
  }

  it('resolves the version hashes and purges the by-hash URL(s)', async () => {
    stubUnpublish();

    await unpublishModelVersionById({ id: VERSION_ID, user: { id: USER_ID } as never });

    expect(mockDb.modelFileHash.findMany).toHaveBeenCalledWith({
      where: { file: { modelVersionId: VERSION_ID } },
      select: { hash: true },
    });
    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
    const arg = mockPurgeCache.mock.calls[0][0] as { urls: string[] };
    expect(new Set(arg.urls)).toEqual(
      new Set([
        'https://civitai.com/api/v1/model-versions/by-hash/DEADBEEF',
        'https://civitai.com/api/v1/model-versions/by-hash/deadbeef',
      ])
    );
  });

  // Defensive guard test (see the delete equivalent above): purgeCache swallows
  // Cloudflare failures internally now, so this asserts the caller stays
  // best-effort against any other throw from the purge path.
  it('does not fail the unpublish if the purge throws (best-effort)', async () => {
    stubUnpublish();
    mockPurgeCache.mockRejectedValue(new Error('cloudflare down'));

    const result = await unpublishModelVersionById({
      id: VERSION_ID,
      user: { id: USER_ID } as never,
    });

    expect(result).toMatchObject({ id: VERSION_ID });
    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
  });
});

describe('publishModelVersionById — by-hash edge-cache purge', () => {
  // The highest-frequency mutation path. Publishing evicts any cached by-hash
  // 404 so the freshly-published version resolves immediately. Rows still exist
  // on publish, so hashes are resolved via modelFileHash.findMany.
  function stubPublish() {
    // currentVersion read (findUniqueOrThrow, then post-tx reads use dbWrite).
    mockDb.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      name: 'v1',
      baseModel: 'SD 1.5',
      earlyAccessConfig: null,
      model: {
        userId: USER_ID,
        name: 'model',
        availability: 'Public',
        publishedAt: new Date('2020-01-01'), // already published → skip Model update
        nsfw: false,
        meta: {},
      },
    });
    // In-transaction update returns the shape the post-commit code reads.
    mockDb.modelVersion.update.mockResolvedValue({
      id: VERSION_ID,
      modelId: MODEL_ID,
      baseModel: 'SD 1.5',
      model: { userId: USER_ID, id: MODEL_ID, type: 'Checkpoint', nsfw: false },
    });
    mockDb.$executeRaw.mockResolvedValue(0);
    mockDb.post.findMany.mockResolvedValue([]);
    mockDb.image.findMany.mockResolvedValue([]);
    // Rows still exist on publish — resolved by-hash via modelFileHash.findMany.
    mockDb.modelFileHash.findMany.mockResolvedValue([{ hash: 'CAFED00D' }]);
  }

  it('resolves the version hashes and purges the by-hash URL(s) on publish', async () => {
    stubPublish();

    await publishModelVersionById({ id: VERSION_ID });

    expect(mockDb.modelFileHash.findMany).toHaveBeenCalledWith({
      where: { file: { modelVersionId: VERSION_ID } },
      select: { hash: true },
    });
    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
    const arg = mockPurgeCache.mock.calls[0][0] as { urls: string[] };
    expect(new Set(arg.urls)).toEqual(
      new Set([
        'https://civitai.com/api/v1/model-versions/by-hash/CAFED00D',
        'https://civitai.com/api/v1/model-versions/by-hash/cafed00d',
      ])
    );
  });

  it('does not fail the publish if the purge throws (best-effort)', async () => {
    stubPublish();
    mockPurgeCache.mockRejectedValue(new Error('cloudflare down'));

    const result = await publishModelVersionById({ id: VERSION_ID });

    expect(result).toMatchObject({ id: VERSION_ID });
    expect(mockPurgeCache).toHaveBeenCalledTimes(1);
  });
});
