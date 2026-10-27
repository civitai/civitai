import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import type * as CommonService from '~/server/services/common.service';
import type * as DonationGoalService from '~/server/services/donation-goal.service';
import type * as ReportService from '~/server/services/report.service';
import type * as CreatorMembershipService from '~/server/services/creator-membership.service';
import type * as UserService from '~/server/services/user.service';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

// FLIPT_FEATURE_FLAGS stays real; the keys below are literals, so a renamed enum value goes red.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads3>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModel,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  modelTagCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getResourceData: vi.fn(async () => []),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  getViewerMonetization: vi.fn(async ({ versions }: { versions: { id: number }[] }) =>
    Object.fromEntries(
      versions.map((v) => [v.id, { paidAccess: undefined, licensingFee: null, sale: null }])
    )
  ),
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: vi.fn(async () => []),
}));
vi.mock('~/server/services/donation-goal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DonationGoalService>()),
  getOwnerDonationGoals: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  getLatestAppeal: vi.fn(async () => null),
}));
vi.mock('~/server/services/creator-membership.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorMembershipService>()),
  getOwnerMetricPrivacyDefaultsForEditor: vi.fn(async () => null),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));

const queries = await import('@civitai/db-queries/hot-reads-3');
const { dbMock } = await import('~/__tests__/mocks/db.mock');
const { kyselyRead } = await import('~/server/db/kyselyDb');
const { isFlipt } = await import('~/server/flipt/client');
const { getModelHandler } = await import('~/server/controllers/model.controller');

/**
 * `model.getById` reads the model owner's posts on the visible versions to fill
 * `modelVersions[].posts`, which only owner/moderator UI reads. Behind
 * `model-getbyid-skip-owner-posts`, a viewer who is neither gets `posts: []` (what an owner with no
 * posts gets) without the read, on both the Prisma and the Kysely path. Owners, moderators, and
 * everyone while the flag is off: the read runs as before.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

// Pairwise distinct ids, none equal to another constant here.
const MODEL = 7101;
const OWNER = 7202;
const OTHER = 7303;
const MOD = 7404;
const VERSION = 7505;
const POST = 7606;
const ELSEWHERE_POST = 7707;
const ELSEWHERE_VERSION = 7808;

const SKIP = 'model-getbyid-skip-owner-posts';
const KYSELY = 'kysely-hot-reads-3';

const VIEWERS = {
  anonymous: undefined,
  other: { id: OTHER, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: MOD, isModerator: true },
} as const;
type Viewer = keyof typeof VIEWERS;

// One owner post on the version and one on a version the model does not carry, so the mapped field
// is a non-empty literal that a skipped read cannot produce.
const POST_ROWS = [
  { id: POST, modelVersionId: VERSION },
  { id: ELSEWHERE_POST, modelVersionId: ELSEWHERE_VERSION },
];
const PRISMA_POSTS_CALL = {
  where: { modelVersionId: { in: [VERSION] }, userId: OWNER },
  select: { id: true, modelVersionId: true },
  orderBy: { id: 'asc' },
};

const flagsOn = (...keys: string[]) =>
  flag.mockImplementation(async (key) => keys.includes(key as string));

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({ userCosmetics: [], cosmetics: [], profilePictures: [] });
  getModel.mockResolvedValue({
    id: MODEL,
    name: 'A model',
    poi: false,
    minor: false,
    nsfw: false,
    nsfwLevel: 1,
    status: ModelStatus.Published,
    meta: null,
    metrics: [],
    user: { id: OWNER, image: null, username: 'owner', deletedAt: null, rank: null },
    modelVersions: [
      {
        id: VERSION,
        name: 'v1',
        status: ModelStatus.Published,
        publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        availability: 'Public',
        usageControl: 'Download',
        baseModel: 'SD 1.5',
        baseModelType: 'Standard',
        flags: 0,
        meta: null,
        description: null,
        files: [],
        metrics: [],
        recommendedResources: [],
        generationCoverage: null,
        generatorLoaded: false,
      },
    ],
  });
  flag.mockReset().mockResolvedValue(false);
  dbMock.dbRead.post.findMany.mockReset().mockResolvedValue(POST_ROWS as never);
  dbMock.dbRead.modelAssociations.count.mockResolvedValue(0);
  q.listModelPagePosts.mockReset().mockResolvedValue(POST_ROWS as never);
  q.countSuggestedResources.mockReset().mockResolvedValue(0);
});

const modelPage = (viewer: Viewer) =>
  getModelHandler({
    input: { id: MODEL },
    ctx: { user: VIEWERS[viewer], features: {} },
  } as never);

const ALL: Viewer[] = ['anonymous', 'other', 'owner', 'moderator'];
const NEITHER: Viewer[] = ['anonymous', 'other'];
const OWNER_OR_MOD: Viewer[] = ['owner', 'moderator'];

describe('getModelHandler owner posts behind model-getbyid-skip-owner-posts', () => {
  it.each(ALL)('OFF, %s: the Prisma read runs and the version carries its post', async (viewer) => {
    const model = await modelPage(viewer);
    expect(dbMock.dbRead.post.findMany.mock.calls).toEqual([[PRISMA_POSTS_CALL]]);
    expect(model.modelVersions.map((v) => v.posts)).toStrictEqual([[{ id: POST }]]);
  });

  it.each(NEITHER)('ON, %s: no read on either path, and posts is []', async (viewer) => {
    flagsOn(SKIP);
    const model = await modelPage(viewer);
    expect(dbMock.dbRead.post.findMany).not.toHaveBeenCalled();
    expect(q.listModelPagePosts).not.toHaveBeenCalled();
    expect(model.modelVersions.map((v) => v.posts)).toStrictEqual([[]]);
  });

  it.each(NEITHER)(
    'ON with kysely-hot-reads-3 ON, %s: the Kysely read is skipped too',
    async (viewer) => {
      flagsOn(SKIP, KYSELY);
      const model = await modelPage(viewer);
      expect(q.listModelPagePosts).not.toHaveBeenCalled();
      expect(dbMock.dbRead.post.findMany).not.toHaveBeenCalled();
      expect(model.modelVersions.map((v) => v.posts)).toStrictEqual([[]]);
    }
  );

  it.each(OWNER_OR_MOD)('ON, %s: the Prisma read runs as before', async (viewer) => {
    flagsOn(SKIP);
    const model = await modelPage(viewer);
    expect(dbMock.dbRead.post.findMany.mock.calls).toEqual([[PRISMA_POSTS_CALL]]);
    expect(model.modelVersions.map((v) => v.posts)).toStrictEqual([[{ id: POST }]]);
  });

  it.each(OWNER_OR_MOD)(
    'ON with kysely-hot-reads-3 ON, %s: the Kysely read runs as before',
    async (viewer) => {
      flagsOn(SKIP, KYSELY);
      const model = await modelPage(viewer);
      expect(q.listModelPagePosts.mock.calls).toEqual([
        [kyselyRead, { modelVersionIds: [VERSION], userId: OWNER }],
      ]);
      expect(model.modelVersions.map((v) => v.posts)).toStrictEqual([[{ id: POST }]]);
    }
  );

  it('the skipped value is exactly what an owner with no posts gets', async () => {
    dbMock.dbRead.post.findMany.mockResolvedValue([]);
    const owner = await modelPage('owner');
    flagsOn(SKIP);
    const other = await modelPage('other');
    expect(owner.modelVersions.map((v) => v.posts)).toStrictEqual([[]]);
    expect(other.modelVersions.map((v) => v.posts)).toStrictEqual(
      owner.modelVersions.map((v) => v.posts)
    );
  });

  it('evaluates the key with no entity or context, once, for a viewer who is neither', async () => {
    await modelPage('other');
    expect(flag.mock.calls.filter(([key]) => key === SKIP)).toEqual([[SKIP]]);
  });
});
