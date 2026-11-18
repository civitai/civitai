import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ResourceInsight from '~/server/services/resource-insight';
import { ModelModifier } from '~/shared/utils/prisma/enums';

/**
 * Builds a model's search document through the real transform (`getModelSearchIndexRecords` runs
 * the same `transformData` the indexer writes with). Only its lookups are faked: the database rows,
 * the images cache and the services that decorate a document.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn(async () => []) }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getModelPaidAccessGates: vi.fn(async () => new Map()),
  getModelVersionPaidAccessTerms: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/resource-insight', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceInsight>()),
  loadResourceInsights: vi.fn(async () => new Map()),
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));

const { getModelSearchIndexRecords, pullModelsData } = await import(
  '~/server/search-index/models.search-index'
);
const { modelTagCache } = await import('~/server/redis/caches');
const { imagesForModelVersionsCache } = await import('~/server/services/image.service');

const MODEL = 1;
const VERSION = 10;
const now = new Date('2026-11-01T00:00:00Z');

const modelRow = (mode: ModelModifier | null) => ({
  id: MODEL,
  name: 'model',
  type: 'LORA',
  mode,
  status: 'Published',
  availability: 'Public',
  nsfw: false,
  nsfwLevel: 1,
  minor: false,
  sfwOnly: false,
  poi: false,
  meta: null,
  createdAt: now,
  lastVersionAt: now,
  publishedAt: now,
  locked: false,
  earlyAccessDeadline: null,
  checkpointType: null,
  uploadType: 'Created',
  coverImageId: 102,
  sfwCoverImageId: 101,
  sfwName: null,
  sfwDescription: null,
  allowNoCredit: true,
  allowCommercialUse: [],
  allowDerivatives: true,
  allowDifferentLicense: true,
  hashes: [],
  user: { id: 5, username: 'creator', deletedAt: null, image: null, profilePicture: null },
  metrics: [],
  tagsOnModels: [],
  modelVersions: [
    {
      id: VERSION,
      name: 'v1',
      baseModel: 'SDXL 1.0',
      baseModelType: null,
      status: 'Published',
      availability: 'Public',
      nsfwLevel: 1,
      createdAt: now,
      publishedAt: now,
      trainedWords: [],
      covered: true,
      settings: null,
      files: [],
      hashes: [],
      metrics: [],
      earlyAccessEndsAt: null,
      earlyAccessConfig: null,
      usageControl: 'Download',
    },
  ],
});

const image = (id: number) => ({
  id,
  modelVersionId: VERSION,
  availability: 'Public',
  url: `url-${id}`,
  nsfwLevel: 1,
  userId: 5,
  width: 512,
  height: 512,
  hash: null,
  type: 'image',
  metadata: {},
  tags: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
  vi.spyOn(modelTagCache, 'fetch').mockResolvedValue({} as never);
  vi.spyOn(imagesForModelVersionsCache, 'fetch').mockResolvedValue({
    [VERSION]: { modelVersionId: VERSION, images: [image(101), image(102), image(103)] },
  } as never);
});

const documentFor = async (mode: ModelModifier | null) => {
  dbMock.dbRead.model.findMany.mockResolvedValue([modelRow(mode)] as never);
  const [doc] = await getModelSearchIndexRecords([MODEL]);
  return doc as unknown as {
    images: { id: number }[];
    coverImageId: number | null;
    sfwCoverImageId: number | null;
  };
};

describe("a model's search document, built by the real transform", () => {
  it('lists a taken-down model with no images and no cover ids', async () => {
    const doc = await documentFor(ModelModifier.TakenDown);
    expect(doc.images).toEqual([]);
    expect(doc.coverImageId).toBeNull();
    expect(doc.sfwCoverImageId).toBeNull();
  });

  // bypassLocal reaches imagesForModelVersionsCache's appendFn, which reads the images' tag ids. The
  // index builder's document keeps them until the next reindex, so they must not come from this
  // process's L1; the request path (resource picker) stores nothing and must stay on the L1.
  it("the index builder reads the version images past this process's L1", async () => {
    const db = { model: { findMany: vi.fn(async () => [modelRow(null)]) } };
    await pullModelsData({ db, logger: () => undefined } as never, {
      type: 'update',
      ids: [MODEL],
    });
    expect(imagesForModelVersionsCache.fetch).toHaveBeenCalledTimes(1);
    expect(imagesForModelVersionsCache.fetch).toHaveBeenCalledWith([VERSION], {
      bypassLocal: true,
    });
  });

  it('the request-path records read the version images through the L1', async () => {
    await documentFor(null);
    expect(imagesForModelVersionsCache.fetch).toHaveBeenCalledTimes(1);
    const [ids, options] = vi.mocked(imagesForModelVersionsCache.fetch).mock.calls[0] as unknown[];
    expect(ids).toEqual([VERSION]);
    expect((options as { bypassLocal?: boolean } | undefined)?.bypassLocal).not.toBe(true);
  });

  it('keeps the images and cover ids of an archived model', async () => {
    const doc = await documentFor(ModelModifier.Archived);
    expect(doc.images.map((i) => i.id)).toEqual(expect.arrayContaining([101, 102, 103]));
    expect(doc.coverImageId).toBe(102);
    expect(doc.sfwCoverImageId).toBe(101);
  });
});
