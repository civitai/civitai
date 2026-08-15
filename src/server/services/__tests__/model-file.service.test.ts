import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// One local named `mockDbRead` served BOTH clients, and the file drives both sides of a genuine
// split: `count` (model-file.service:599), `findFirst` (:617) and `findMany` (:36) are dbRead,
// while `findUnique` and `update` belong to markFileReplaced (:334, :347) and restoreReplacedFile
// (:368, :382) and are dbWrite.
//
// 🔴 `expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled()` below is the assertion that
// makes the routing load-bearing: `update` exists only on dbWrite, so routing it to dbRead would
// satisfy that negative whatever the code did.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// model-file.service builds a cached object at import (filesForModelVersionCache);
// stub the cache/redis/cloudflare surface so importing it here doesn't require a
// live redis connection.
// `lookupFn` isn't reachable through this stub, so the cache-filter test below calls
// the exported `fetchModelFilesForCache` directly instead of going through the cache object.
// `mockCacheFetch` is hoisted so the getFilesForModelVersionCache tests below can drive what
// the cache hands back (the point of those tests is what the ACCESSOR does to that value).
const { mockCacheFetch } = vi.hoisted(() => ({ mockCacheFetch: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ bust: vi.fn(), fetch: mockCacheFetch, lookupFn: undefined }),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));

import * as modelFileService from '~/server/services/model-file.service';
import {
  hasOfficialFileOfSize,
  findOfficialFileByHash,
  markFileReplaced,
  restoreReplacedFile,
  fetchModelFilesForCache,
  getFilesForModelVersionCache,
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
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      visibility: ModelFileVisibility.Public,
      metadata: { format: 'SafeTensor' },
      modelVersionId: 10,
    });

    const res = await markFileReplaced({ fileId: 88, recommendedResourceId: 1 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbWrite.modelFile.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 88 });
    expect(arg.data.replacedAt).toBeInstanceOf(Date);
    expect(arg.data.visibility).toBe(ModelFileVisibility.Private);
    expect(arg.data.metadata).toMatchObject({
      format: 'SafeTensor',
      replacedBy: { recommendedResourceId: 1, priorVisibility: ModelFileVisibility.Public },
    });
  });

  it('throws when the file does not exist', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue(null);
    await expect(markFileReplaced({ fileId: 999, recommendedResourceId: 1 })).rejects.toThrow();
  });

  it('is a no-op when the file is already quarantined', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      visibility: ModelFileVisibility.Private,
      metadata: {
        format: 'SafeTensor',
        replacedBy: { priorVisibility: ModelFileVisibility.Public },
      },
      modelVersionId: 10,
    });

    const res = await markFileReplaced({ fileId: 88, recommendedResourceId: 2 });

    expect(res).toEqual({ modelVersionId: 10 });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('restoreReplacedFile', () => {
  it('reverts replacedAt + prior visibility and clears the replacedBy marker', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      dataPurged: false,
      metadata: {
        format: 'SafeTensor',
        replacedBy: { priorVisibility: ModelFileVisibility.Private },
      },
      modelVersionId: 10,
    });

    const res = await restoreReplacedFile({ id: 88 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbWrite.modelFile.update.mock.calls[0][0];
    expect(arg.data.replacedAt).toBeNull();
    expect(arg.data.visibility).toBe(ModelFileVisibility.Private);
    expect(arg.data.metadata).toEqual({ format: 'SafeTensor' });
  });

  it('rejects when the file is not replaced', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: null,
      dataPurged: false,
      metadata: {},
      modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });

  it('rejects once bytes have been purged', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      dataPurged: true,
      metadata: {},
      modelVersionId: 10,
    });
    await expect(restoreReplacedFile({ id: 88 })).rejects.toThrow();
  });

  it('defaults visibility to Public when no priorVisibility was stashed', async () => {
    mockDbWrite.modelFile.findUnique.mockResolvedValue({
      id: 88,
      replacedAt: new Date(),
      dataPurged: false,
      metadata: {},
      modelVersionId: 10,
    });

    const res = await restoreReplacedFile({ id: 88 });

    expect(res).toEqual({ modelVersionId: 10 });
    const arg = mockDbWrite.modelFile.update.mock.calls[0][0];
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

/**
 * ACCESSOR CONTRACT — the accessor must not hand a caller a `files` array that is shared with
 * the cache layer.
 *
 * 🔴 READ THIS BEFORE TRUSTING THE COVERAGE BELOW. These tests drive a MOCKED
 * `createCachedObject` (see the wholesale `~/server/utils/cache-helpers` mock at the top of this
 * file) and hand-construct the aliasing they then assert against. That makes them a contract test
 * for THIS FUNCTION — they would pass against a completely broken cache layer and fail against a
 * fixed one, because the cache layer is not present.
 *
 * The REAL degraded window — rejecting `mGet` → genuine fail-open → genuine per-id single-flight
 * joined by two callers → the real `lookupFn` → the real accessor — is driven in the "H2b" block
 * of `src/server/utils/__tests__/cache-helpers-failopen.test.ts`. That is where the hazard is
 * OBSERVED; this block only pins the accessor's own behaviour.
 *
 * Why the accessor copies at all: `createCachedArray`
 * (`packages/civitai-redis/src/cached-array.ts`) only ever SHALLOW-clones a record before handing
 * it out, and documents that nested refs stay shared — "shallow only protects TOP-LEVEL fields …
 * consumers MUST treat returned values as read-only for nested fields". The one consumer that
 * mutated the array (`getModelsWithVersions` doing `files.push(...vaeFile)`) has been fixed to
 * build a new array instead, so the copy here is FORWARD-PROTECTION for the next consumer, not a
 * fix for a live mutator.
 */
/**
 * The cache object itself must stay module-private, so the caller-owned-`files` contract cannot be
 * bypassed by reaching past the accessor. This reads the module's ACTUAL export namespace (not the
 * source text), so it fails the moment an `export` keyword is put back on it — which is the only
 * way the bypass can reappear.
 */
describe('module export surface', () => {
  it('does NOT export the raw filesForModelVersionCache — reads go through the accessor', () => {
    const exports = Object.keys(modelFileService);
    // positive control: the accessor/wrapper pair IS exported, so an empty/undefined namespace
    // cannot make the negative assertion below pass vacuously.
    expect(exports).toContain('getFilesForModelVersionCache');
    expect(exports).toContain('deleteFilesForModelVersionCache');
    expect(exports).not.toContain('filesForModelVersionCache');
  });
});

describe('getFilesForModelVersionCache — nested files array is caller-owned', () => {
  beforeEach(() => mockCacheFetch.mockReset());

  // One record object reused across fetches, as an L1 hit / degraded single-flight would.
  function sharedCacheSource() {
    const cached = {
      '42': { modelVersionId: 42, files: [{ id: 1, name: 'base.safetensors' }] },
    };
    mockCacheFetch.mockImplementation(async () => ({ '42': { ...cached['42'] } }));
    return cached;
  }

  it('returns a files array that is NOT the cached record’s array', async () => {
    const cached = sharedCacheSource();
    const result = await getFilesForModelVersionCache([42]);
    expect(result['42'].files).toEqual(cached['42'].files);
    expect(result['42'].files).not.toBe(cached['42'].files);
  });

  it('appending a VAE file does not leak into a later read (the getModelsWithVersions path)', async () => {
    const cached = sharedCacheSource();

    const first = await getFilesForModelVersionCache([42]);
    expect(first['42'].files).toHaveLength(1);
    // exactly what model.service.ts getModelsWithVersions does with the linked VAE.
    // 🔴 `as unknown[]` on the ARRAY, not `as never` on the element and not `any`: `files` is
    // typed as the full Prisma-derived model-file row, and these fixtures are deliberately
    // two-field stubs — identity is all these tests read. Widening the receiver keeps the cast
    // to the push call alone, so every other read of `files` in this file stays fully typed
    // (same pattern as the H2b block in `cache-helpers-failopen.test.ts`).
    (first['42'].files as unknown[]).push({ id: 999, name: 'linked.vae.safetensors' });

    const second = await getFilesForModelVersionCache([42]);
    expect(second['42'].files).toHaveLength(1);
    expect(second['42'].files.map((f) => f.name)).toEqual(['base.safetensors']);
    expect(cached['42'].files).toHaveLength(1);
  });

  it('isolates two concurrent callers from each other (degraded single-flight shape)', async () => {
    const shared = { modelVersionId: 42, files: [{ id: 1, name: 'base.safetensors' }] };
    // The degraded path awaits ONE promise per id and shallow-clones it per caller, so every
    // caller's record carries the SAME nested array. Model that exactly.
    mockCacheFetch.mockImplementation(async () => ({ '42': { ...shared } }));

    const [a, b] = await Promise.all([
      getFilesForModelVersionCache([42]),
      getFilesForModelVersionCache([42]),
    ]);
    expect(a['42'].files).not.toBe(b['42'].files);

    (a['42'].files as unknown[]).push({ id: 999, name: 'linked.vae.safetensors' });
    expect(b['42'].files).toHaveLength(1);
  });

  it('preserves the record shape and the file contents', async () => {
    sharedCacheSource();
    const result = await getFilesForModelVersionCache([42]);
    expect(Object.keys(result)).toEqual(['42']);
    expect(result['42']).toEqual({
      modelVersionId: 42,
      files: [{ id: 1, name: 'base.safetensors' }],
    });
  });

  // EVERY record must be isolated, not just the first one the map happens to visit — a
  // batched fetch is the normal shape here (a feed page hydrates ~100 version ids at once).
  it('isolates every record in a multi-id batch, not only the first', async () => {
    const cached = {
      '42': { modelVersionId: 42, files: [{ id: 1, name: 'a.safetensors' }] },
      '43': { modelVersionId: 43, files: [{ id: 2, name: 'b.safetensors' }] },
      '44': { modelVersionId: 44, files: [{ id: 3, name: 'c.safetensors' }] },
    };
    mockCacheFetch.mockImplementation(async () =>
      Object.fromEntries(Object.entries(cached).map(([k, v]) => [k, { ...v }]))
    );

    const result = await getFilesForModelVersionCache([42, 43, 44]);
    expect(Object.keys(result)).toEqual(['42', '43', '44']);
    for (const id of ['42', '43', '44'] as const) {
      expect(result[id].files).not.toBe(cached[id].files);
      (result[id].files as unknown[]).push({ id: 999, name: 'linked.vae.safetensors' });
      expect(cached[id].files).toHaveLength(1);
    }
  });

  // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE. With the real cache this state is UNREACHABLE:
  // `lookupFn` always initialises `files: []` (model-file.service.ts), and marker records
  // (`notFound`/`debounce`) are `continue`d inside the cache layer before they can be returned
  // (packages/civitai-redis/src/cached-array.ts). So the `Array.isArray` guard cannot fire in
  // production, and this test only pins a shape the MOCK above can produce. It is kept because a
  // future cache-layer or lookupFn change could make the state reachable, and because throwing on
  // a hot public-API read path is a worse failure than passing the record through — but it must
  // not be counted as evidence of a demonstrated hazard, and in a mutation battery it is the sole
  // kill for the guard-removal mutant, i.e. that arm scores against an unreachable state.
  it('INVARIANT GUARD (unreachable with the real cache): passes through a record with no files array instead of throwing', async () => {
    mockCacheFetch.mockImplementation(async () => ({ '42': { modelVersionId: 42 } }));
    const result = await getFilesForModelVersionCache([42]);
    expect(result['42']).toEqual({ modelVersionId: 42 });
  });
});
