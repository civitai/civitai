import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelFile: {
      count: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));

// model-file.service builds a cached object at import (filesForModelVersionCache);
// stub the cache/redis/cloudflare surface so importing it here doesn't require a
// live redis connection — these official-file helpers only touch dbRead.
// `lookupFn` isn't reachable through this stub, so the cache-filter test below calls
// the exported `fetchModelFilesForCache` directly instead of going through the cache object.
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ bust: vi.fn(), fetch: vi.fn(), lookupFn: undefined }),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/redis/client', () => ({
  REDIS_KEYS: { CACHES: { FILES_FOR_MODEL_VERSION: 'files-for-model-version' } },
}));

import {
  hasOfficialFileOfSize,
  findOfficialFileByHash,
  markFileReplaced,
  restoreReplacedFile,
  fetchModelFilesForCache,
} from '~/server/services/model-file.service';
import { constants } from '~/server/common/constants';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';

const OFFICIAL = constants.system.officialUserId;

// A standalone VAE stores its bytes as a type='Model' file inside a VAE-type model.
const officialVaeRow = {
  id: 900,
  name: 'boogu.vae.safetensors',
  sizeKB: 300_000,
  type: 'Model',
  modelVersionId: 42,
  modelVersion: { name: 'v1', modelId: 7, model: { name: 'Boogu VAE', type: 'VAE' } },
};

// A text encoder bundled inside a checkpoint: the file's own type carries the role.
const officialBundledEncoderRow = {
  id: 901,
  name: 'qwen3.encoder.safetensors',
  sizeKB: 3_400_000,
  type: 'Text Encoder',
  modelVersionId: 43,
  modelVersion: { name: 'v1', modelId: 8, model: { name: 'Z Image Base', type: 'Checkpoint' } },
};

beforeEach(() => vi.clearAllMocks());

describe('hasOfficialFileOfSize', () => {
  it('scopes to the official account and the exact sizeKB', async () => {
    mockDbRead.modelFile.count.mockResolvedValue(1);
    expect(await hasOfficialFileOfSize(300_000)).toBe(true);
    const arg = mockDbRead.modelFile.count.mock.calls[0][0];
    expect(arg.where.sizeKB).toBe(300_000);
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });

  it('returns false when the official account has no file of that size', async () => {
    mockDbRead.modelFile.count.mockResolvedValue(0);
    expect(await hasOfficialFileOfSize(300_000)).toBe(false);
  });
});

describe('findOfficialFileByHash', () => {
  it('matches a canonical type="Model" file and derives componentType from the official model type', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialVaeRow);
    // Pass lowercase input (as computeBlobSha256 produces); query must uppercase it to match stored UPPERCASE hex
    const match = await findOfficialFileByHash({ sha256: 'abcdef' });
    expect(match).toEqual({
      versionId: 42,
      fileId: 900,
      modelId: 7,
      modelName: 'Boogu VAE',
      versionName: 'v1',
      fileName: 'boogu.vae.safetensors',
      sizeKB: 300_000,
      componentType: 'VAE',
    });
    // hash uppercased in the query (stored ModelFileHash.hash is UPPERCASE hex)
    const arg = mockDbRead.modelFile.findFirst.mock.calls[0][0];
    expect(arg.where.hashes.some.hash).toBe('ABCDEF');
    expect(arg.where.hashes.some.type).toBe('SHA256');
    expect(arg.where.modelVersion.model.userId).toBe(OFFICIAL);
  });

  it('derives componentType from the official file type for a bundled component', async () => {
    // Official text encoder bundled in a checkpoint — the file's own type carries the role.
    mockDbRead.modelFile.findFirst.mockResolvedValue(officialBundledEncoderRow);
    const match = await findOfficialFileByHash({ sha256: 'abcdef' });
    expect(match?.componentType).toBe('TextEncoder');
  });

  it('returns null when the official match is a checkpoint (not a linkable accessory)', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue({
      id: 902,
      name: 'flux.safetensors',
      sizeKB: 10_000_000,
      type: 'Model',
      modelVersionId: 44,
      modelVersion: { name: 'v1', modelId: 9, model: { name: 'Flux', type: 'Checkpoint' } },
    });
    expect(await findOfficialFileByHash({ sha256: 'abcdef' })).toBeNull();
  });

  it('returns null for primary-weights file types (Diffusion Model / UNet), not just checkpoints', async () => {
    // Flux/Wan/ZImage main files are type 'Diffusion Model' / 'UNet' — primary weights,
    // never linkable accessories even though inferComponentType maps them to non-null.
    for (const type of ['Diffusion Model', 'UNet']) {
      mockDbRead.modelFile.findFirst.mockResolvedValue({
        id: 903,
        name: 'flux.safetensors',
        sizeKB: 12_000_000,
        type,
        modelVersionId: 45,
        modelVersion: { name: 'v1', modelId: 10, model: { name: 'Flux', type: 'Checkpoint' } },
      });
      expect(await findOfficialFileByHash({ sha256: 'abcdef' })).toBeNull();
    }
  });

  it('returns null when no official file has the hash', async () => {
    mockDbRead.modelFile.findFirst.mockResolvedValue(null);
    expect(await findOfficialFileByHash({ sha256: 'abc' })).toBeNull();
  });
});

describe('markFileReplaced', () => {
  it('flags the file replaced + private and stashes prior visibility, without deleting', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88,
      visibility: ModelFileVisibility.Public,
      metadata: { format: 'SafeTensor' },
      modelVersionId: 10,
    });

    const res = await markFileReplaced({ fileId: 88, recommendedResourceId: 1 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbRead.modelFile.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 88 });
    expect(arg.data.replacedAt).toBeInstanceOf(Date);
    expect(arg.data.visibility).toBe(ModelFileVisibility.Private);
    expect(arg.data.metadata).toMatchObject({
      format: 'SafeTensor',
      replacedBy: { recommendedResourceId: 1, priorVisibility: ModelFileVisibility.Public },
    });
  });

  it('throws when the file does not exist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(null);
    await expect(markFileReplaced({ fileId: 999, recommendedResourceId: 1 })).rejects.toThrow();
  });

  it('is a no-op when the file is already quarantined', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      visibility: ModelFileVisibility.Private,
      metadata: { format: 'SafeTensor', replacedBy: { priorVisibility: ModelFileVisibility.Public } },
      modelVersionId: 10,
    });

    const res = await markFileReplaced({ fileId: 88, recommendedResourceId: 2 });

    expect(res).toEqual({ modelVersionId: 10 });
    expect(mockDbRead.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('restoreReplacedFile', () => {
  it('reverts replacedAt + prior visibility and clears the replacedBy marker', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      dataPurged: false,
      metadata: { format: 'SafeTensor', replacedBy: { priorVisibility: ModelFileVisibility.Private } },
      modelVersionId: 10,
    });

    const res = await restoreReplacedFile({ id: 88 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbRead.modelFile.update.mock.calls[0][0];
    expect(arg.data.replacedAt).toBeNull();
    expect(arg.data.visibility).toBe(ModelFileVisibility.Private);
    expect(arg.data.metadata).toEqual({ format: 'SafeTensor' });
  });

  it('rejects when the file is not replaced', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88, replacedAt: null, dataPurged: false, metadata: {}, modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });

  it('rejects once bytes have been purged', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88, replacedAt: new Date(), dataPurged: true, metadata: {}, modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });

  it('defaults visibility to Public when no priorVisibility was stashed', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      id: 88, replacedAt: new Date(), dataPurged: false, metadata: {}, modelVersionId: 10,
    });

    const res = await restoreReplacedFile({ id: 88 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbRead.modelFile.update.mock.calls[0][0];
    expect(arg.data.replacedAt).toBeNull();
    expect(arg.data.visibility).toBe(ModelFileVisibility.Public);
  });
});

describe('fetchModelFilesForCache', () => {
  it('excludes replaced (quarantined) files from the version file list', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([]);
    await fetchModelFilesForCache([10]);
    const arg = mockDbRead.modelFile.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ modelVersionId: { in: [10] }, replacedAt: null });
  });
});
