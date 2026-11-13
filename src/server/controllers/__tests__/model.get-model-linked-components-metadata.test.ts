import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installUserCosmeticCacheFake } from '~/test-utils/userCosmeticCacheFake';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads3>()),
  listModelPagePosts: vi.fn(async () => []),
  countSuggestedResources: vi.fn(async () => 0),
  getUserSettings: vi.fn(async () => undefined),
}));
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

vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasEntityAccess: vi.fn(async () => []),
}));

const { getModelHandler } = await import('~/server/controllers/model.controller');

/**
 * The model page's linked components name files of other models. Their metadata reaches any viewer,
 * so it carries only the basic fields, never the linked file's training epoch URLs.
 */

const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';
const LINKED_FILE = 55;

beforeEach(() => {
  vi.clearAllMocks();
  installUserCosmeticCacheFake({ userCosmetics: [], cosmetics: [], profilePictures: [] });
  getModel.mockResolvedValue({
    id: 1,
    name: 'm',
    description: null,
    sfwName: null,
    sfwDescription: null,
    poi: false,
    minor: false,
    nsfw: false,
    nsfwLevel: 1,
    status: ModelStatus.Published,
    meta: null,
    metrics: [],
    user: { id: 10, image: null, username: 'owner', deletedAt: null },
    modelVersions: [
      {
        id: 10,
        status: ModelStatus.Published,
        publishedAt: new Date(0),
        files: [],
        metrics: [],
        meta: null,
        recommendedResources: [
          {
            id: 3,
            resource: { id: 20 },
            settings: { isLinkedComponent: true, fileId: LINKED_FILE, componentType: 'VAE' },
          },
        ],
      },
    ],
  });
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([
    {
      id: LINKED_FILE,
      name: 'vae.safetensors',
      sizeKB: 1,
      type: 'VAE',
      metadata: {
        format: 'SafeTensor',
        size: 'full',
        fp: 'fp16',
        quantType: 'Q4_K_M',
        selectedEpochUrl: EPOCH_URL,
        trainingResults: { epochs: [{ modelUrl: EPOCH_URL }] },
      },
    },
  ] as never);
});

describe('model.getById linked components', () => {
  it('returns only the basic metadata of a linked file to an anonymous caller', async () => {
    const model = await getModelHandler({
      input: { id: 1 },
      ctx: { user: undefined, features: {} },
    } as never);

    expect(model.modelVersions[0].linkedComponents).toHaveLength(1);
    expect(model.modelVersions[0].linkedComponents[0].fileMetadata).toEqual({
      format: 'SafeTensor',
      size: 'full',
      fp: 'fp16',
      quantType: 'Q4_K_M',
    });
  });
});
