import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Locks the `where` shape validateContestCollectionEntry builds for model entries. The
 * no-gating path must stay byte-for-byte identical to the date-only rule — a live contest
 * with accepted entries depends on it — and when gating is on, the date and base-model
 * conditions must sit inside ONE modelVersions.none object so a single version has to
 * satisfy both.
 *
 * Scaffold mirrors contest-entry-resource-gate.test.ts.
 */

const COLLECTION_ID = 100;
const USER_ID = 5;
const MODEL_ID = 7001;
const START_DATE = new Date('2026-07-24T00:00:00.000Z');

const { mockChargeEntryFees, mockChallengeFindFirst, mockModelFindMany, mockDbRead } = vi.hoisted(
  () => {
    const mockChargeEntryFees = vi.fn();
    const mockChallengeFindFirst = vi.fn(async () => null);
    const mockModelFindMany = vi.fn();
    const mockDbRead = {
      user: { findUnique: vi.fn() },
      challenge: { findFirst: mockChallengeFindFirst },
      collectionItem: { count: vi.fn(), findFirst: vi.fn() },
      collection: { findMany: vi.fn() },
      image: { findMany: vi.fn() },
      article: { findMany: vi.fn() },
      model: { findMany: mockModelFindMany },
      post: { findMany: vi.fn() },
      imageResourceNew: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
    };
    return { mockChargeEntryFees, mockChallengeFindFirst, mockModelFindMany, mockDbRead };
  }
);

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { get: vi.fn(), set: vi.fn(), packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: { get: vi.fn(), set: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p) => p),
  };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

// @civitai/db's index re-exports ./kysely, whose top-level `import 'kysely'` is not
// installed in this worktree. Replacing the whole package short-circuits that eval.
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/db/pgDb', async () => {
  const { createPgDbMock } = await import('~/test-utils/pgDbMock');
  return createPgDbMock();
});
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: {},
  userCollectionCountCache: {},
}));
vi.mock('~/server/services/article.service', () => ({ getArticles: vi.fn() }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: vi.fn(),
  bustFeaturedModelsCache: vi.fn(),
  getModelsWithImagesAndModelVersions: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ getPostsInfinite: vi.fn() }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeEntryFees: mockChargeEntryFees,
}));

const { validateContestCollectionEntry } = await import('~/server/services/collection.service');

// model.findMany serves two calls: the ownership check (selects userId) and the eligibility
// gate under test. Only the latter is asserted on.
function gateCall() {
  const call = mockModelFindMany.mock.calls.find(([args]) => !args.select?.userId);
  return call?.[0];
}

async function submitModel(metadata: Record<string, unknown>) {
  return validateContestCollectionEntry({
    collectionId: COLLECTION_ID,
    userId: USER_ID,
    modelIds: [MODEL_ID],
    metadata,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.user.findUnique.mockResolvedValue({ id: USER_ID, meta: {} });
  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockDbRead.collection.findMany.mockResolvedValue([]); // no featured collections
  mockModelFindMany.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
    select?.userId ? [{ id: MODEL_ID, userId: USER_ID }] : []
  );
});

describe('contest entry base-model gate', () => {
  it('keeps the date-only where shape when no base models are configured', async () => {
    await expect(submitModel({ submissionStartDate: START_DATE })).resolves.toBeUndefined();

    expect(gateCall()).toEqual({
      where: {
        id: { in: [MODEL_ID] },
        createdAt: { lt: START_DATE },
        modelVersions: {
          none: {
            status: { notIn: ['Deleted', 'UnpublishedViolation'] },
            createdAt: { gte: START_DATE },
          },
        },
      },
      select: { id: true },
    });
  });

  it.each([
    ['an empty array', [] as string[]],
    ['an array of empty strings', ['']],
  ])('treats %s as no gating', async (_label, baseModels) => {
    await expect(
      submitModel({ submissionStartDate: START_DATE, baseModels })
    ).resolves.toBeUndefined();

    expect(gateCall().where).not.toHaveProperty('modelVersions.none.baseModel');
    expect(gateCall().where.createdAt).toEqual({ lt: START_DATE });
  });

  it('puts the date and base-model conditions on the same version, and drops the model-row date', async () => {
    await expect(
      submitModel({ submissionStartDate: START_DATE, baseModels: ['Flux.1 Krea'] })
    ).resolves.toBeUndefined();

    expect(gateCall()).toEqual({
      where: {
        id: { in: [MODEL_ID] },
        modelVersions: {
          none: {
            status: { notIn: ['Deleted', 'UnpublishedViolation'] },
            createdAt: { gte: START_DATE },
            baseModel: { in: ['Flux.1 Krea'] },
          },
        },
      },
      select: { id: true },
    });
  });

  it('gates a windowless contest on base model alone', async () => {
    await expect(submitModel({ baseModels: ['Flux.1 Krea'] })).resolves.toBeUndefined();

    expect(gateCall()).toEqual({
      where: {
        id: { in: [MODEL_ID] },
        modelVersions: {
          none: {
            status: { notIn: ['Deleted', 'UnpublishedViolation'] },
            baseModel: { in: ['Flux.1 Krea'] },
          },
        },
      },
      select: { id: true },
    });
  });

  it('skips the query when neither rule is configured', async () => {
    await expect(submitModel({})).resolves.toBeUndefined();

    expect(gateCall()).toBeUndefined();
  });

  it('names the allowed base models when a gated entry is rejected', async () => {
    mockModelFindMany.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
      select?.userId ? [{ id: MODEL_ID, userId: USER_ID }] : [{ id: MODEL_ID }]
    );

    await expect(
      submitModel({ submissionStartDate: START_DATE, baseModels: ['Flux.1 Krea', 'Flux.1 D'] })
    ).rejects.toThrow('This contest accepts: Flux.1 Krea, Flux.1 D.');
  });

  it('keeps the original wording when an ungated entry is rejected', async () => {
    mockModelFindMany.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
      select?.userId ? [{ id: MODEL_ID, userId: USER_ID }] : [{ id: MODEL_ID }]
    );

    await expect(submitModel({ submissionStartDate: START_DATE })).rejects.toThrow(
      'Some models predate the submission start date'
    );
  });
});
