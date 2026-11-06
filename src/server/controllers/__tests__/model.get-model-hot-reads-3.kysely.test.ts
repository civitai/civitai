import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

// Every server flag on this path reads off: the owner-posts skip among them, so the posts read
// runs for this viewer.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-3 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-3.kysely-parity.test.ts.
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

const queries = await import('@civitai/db-queries/hot-reads-3');
const { dbMock } = await import('~/__tests__/mocks/db.mock');
const { kyselyRead, kyselyWrite } = await import('~/server/db/kyselyDb');
const { isFlipt } = await import('~/server/flipt/client');
const { getModelHandler } = await import('~/server/controllers/model.controller');

/**
 * The three reads `getModelHandler` makes after the model row: the owner's posts on the visible
 * versions, the suggested-resource count and the owner's settings (read only with metric privacy
 * on, for a viewer who is not the owner). Each reads through Kysely on the replica and touches none
 * of the Prisma reads it replaced. Row parity is in
 * src/server/services/__tests__/hot-reads-3.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct, and distinct from the count below.
const MODEL = 6101;
const OWNER = 6202;
const VIEWER = 6303;
const SUGGESTED = 2;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of kyselyReads()) fn.mockReset();
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
    modelVersions: [],
    user: { id: OWNER, image: null, username: 'owner', deletedAt: null, rank: null },
  });
  flag.mockReset().mockResolvedValue(false);
  q.listModelPagePosts.mockResolvedValue([] as never);
  q.countSuggestedResources.mockResolvedValue(SUGGESTED);
  q.getUserSettings.mockResolvedValue({ settings: {} } as never);
});

const modelPage = () =>
  getModelHandler({
    input: { id: MODEL },
    ctx: {
      user: { id: VIEWER, isModerator: false },
      features: { modelMetricPrivacyReadtime: true },
    },
  } as never);

describe('getModelHandler: the reads after the model row', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('reads the three through Kysely only, on the replica', async () => {
    const model = await modelPage();
    expect(q.listModelPagePosts.mock.calls).toEqual([
      [kyselyRead, { modelVersionIds: [], userId: OWNER }],
    ]);
    expect(q.countSuggestedResources.mock.calls).toEqual([[kyselyRead, MODEL]]);
    expect(q.getUserSettings.mock.calls).toEqual([[kyselyRead, OWNER]]);
    // By identity: `toEqual` above compares the two Kysely clients structurally and cannot tell the
    // replica from the primary.
    for (const read of [q.listModelPagePosts, q.countSuggestedResources, q.getUserSettings])
      expect(read.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.post.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelAssociations.count).not.toHaveBeenCalled();
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { settings: true },
    });
    expect(model.hasSuggestedResources).toBe(true);
  });

  it('the Kysely count decides hasSuggestedResources (zero is false)', async () => {
    q.countSuggestedResources.mockResolvedValue(0);
    const model = await modelPage();
    expect(model.hasSuggestedResources).toBe(false);
  });
});
