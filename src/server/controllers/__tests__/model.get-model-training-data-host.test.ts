import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as Caches from '~/server/redis/caches';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as GenerationService from '~/server/services/generation/generation.service';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const { getModel } = vi.hoisted(() => ({ getModel: vi.fn() }));

// The Kysely reads the handler makes after the model row: no posts, no suggested resources, no
// owner settings. Their rows, against a real database, are pinned in
// src/server/services/__tests__/hot-reads-3.kysely-parity.test.ts.
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

// The listing rule is tested on PGlite (training-data-share.behavior.test.ts); here only that this
// surface asks it with the request's host and applies the answer.
vi.mock('~/server/services/training-data-held.service', () => ({
  trainingDataListing:
    async (
      _db: unknown,
      _versions: unknown,
      { redCapable, viewerManages }: { redCapable: boolean; viewerManages?: boolean }
    ) =>
    (file: { type: string }) =>
      file.type !== 'Training Data' || redCapable || !!viewerManages,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isRedCapableHost: (host?: string | null) => host === 'civitai.red',
}));

const { getModelHandler } = await import('~/server/controllers/model.controller');

/** The model page (`model.getById`) lists a mature training dataset only on a red-capable host. */

const OWNER = 10;
const file = (id: number, type: string, metadata: object) => ({
  id,
  type,
  visibility: 'Public',
  name: `${id}.bin`,
  sizeKB: 1,
  url: `s3://${id}`,
  metadata,
  hashes: [],
  pickleScanResult: 'Success',
  virusScanResult: 'Success',
});

beforeEach(() => {
  vi.clearAllMocks();
  getModel.mockResolvedValue({
    id: 1,
    name: 'model',
    description: '',
    poi: false,
    minor: false,
    sfwOnly: false,
    nsfw: false,
    nsfwLevel: 1,
    lockedProperties: [],
    status: ModelStatus.Published,
    meta: {},
    metrics: [],
    modelVersions: [
      {
        id: 5,
        status: ModelStatus.Published,
        publishedAt: new Date(Date.now() - 86_400_000),
        usageControl: 'Download',
        availability: 'Public',
        baseModel: 'SD 1.5',
        recommendedResources: [],
        metrics: [],
        meta: {},
        files: [
          file(51, 'Model', { format: 'SafeTensor' }),
          file(52, 'Training Data', { nsfwLevel: 4, fullyRated: true }),
        ],
      },
    ],
    user: { id: OWNER, username: 'owner', deletedAt: null },
  });
});

const listed = async (host: string) => {
  const model = await getModelHandler({
    input: { id: 1 },
    ctx: { user: undefined, features: {}, req: { headers: { host } } },
  } as never);
  return model.modelVersions[0].files.map((f: { id: number }) => f.id);
};

describe('model.getById and a mature training dataset', () => {
  it('is left out on a host that is not red-capable', async () => {
    expect(await listed('civitai.com')).toEqual([51]);
  });

  it('is listed on a red-capable host', async () => {
    expect(await listed('civitai.red')).toEqual([51, 52]);
  });
});
