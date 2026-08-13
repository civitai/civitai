import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for GET /api/v1/model-versions/[id] — per-file
 * `downloadUrl` must resolve to the SAME file whose `hashes` / `sizeKB` /
 * `name` were serialized next to it.
 *
 * Same defect and same fix as the sibling `/api/v1/models/[id]` suite: the
 * response built each file's URL with
 * `createModelFileDownloadUrl({ versionId, type, meta, primary: primaryFile.id === file.id })`,
 * which for the elected primary emits a BARE `/api/download/models/<versionId>`
 * that the download route re-resolves on its own (requesting user's
 * filePreferences + its own scoring). On a multi-file version the advertised
 * SHA256 and the file actually served can then disagree.
 *
 * Exercised through the exported `prepareModelVersionResponse`, which is the
 * whole body-shaping path the handler delegates to (the handler above it is one
 * raw SQL read). `createModelFileDownloadUrl` and `getPrimaryFile` are REAL —
 * the URL string and the primary election are the contract under test.
 */

const { mockGetVaeFiles, mockGetImages, mockGetPaidAccess, mockFindUnique } = vi.hoisted(() => ({
  mockGetVaeFiles: vi.fn(),
  mockGetImages: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock('~/server/db/client', () => {
  const stub = {
    modelVersion: { findUnique: mockFindUnique },
    $queryRaw: vi.fn(),
  };
  // The page module's transitive graph reaches for several named exports of this
  // client; a partial mock makes Vitest throw on the first one it can't find.
  return { dbRead: stub, dbWrite: stub, dbKV: stub, dbReadLong: stub, dbReadReplica: stub };
});
vi.mock('~/server/services/model.service', () => ({ getVaeFiles: mockGetVaeFiles }));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: mockGetImages,
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: mockGetPaidAccess,
  toPublicPaidAccessDto: () => null,
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => handler,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

/**
 * Four files on ONE version, PAIRWISE DISTINCT on every axis the implementation
 * could key off (id, type, format, size, fp, sizeKB, hash) so a mutant binding
 * the wrong file cannot coincidentally emit the right URL.
 *
 * File 21 is the one real `getPrimaryFile` elects (type 'Model' +
 * SafeTensor/pruned/fp16 = the default preference) — the exact file the defect
 * emitted a bare, re-resolvable URL for. File 24 is non-Public.
 */
const FILES = [
  {
    id: 21,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 1111,
    modelVersionId: 4242,
    url: 's3://a',
    name: 'a.safetensors',
    hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  },
  {
    id: 22,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 2222,
    modelVersionId: 4242,
    url: 's3://b',
    name: 'b.ckpt',
    hashes: [{ type: 'SHA256', hash: 'bbbb2222' }],
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' },
  },
  {
    id: 23,
    type: 'Config',
    visibility: 'Public',
    sizeKB: 3333,
    modelVersionId: 4242,
    url: 's3://c',
    name: 'c.yaml',
    hashes: [{ type: 'SHA256', hash: 'cccc3333' }],
    metadata: { format: 'Other' },
  },
  {
    id: 24,
    type: 'Model',
    visibility: 'Private',
    sizeKB: 4444,
    modelVersionId: 4242,
    url: 's3://d',
    name: 'd.gguf',
    hashes: [{ type: 'SHA256', hash: 'dddd4444' }],
    metadata: { format: 'GGUF', quantType: 'Q8_0' },
  },
];

const BY_HASH = new Map(FILES.map((f) => [f.hashes[0].hash, f]));

function modelVersion() {
  return {
    id: 4242,
    modelId: 77,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    nsfwLevel: 1,
    licensingFee: null,
    // getVaeFiles pushes into this array, so hand over a fresh copy per call.
    files: FILES.map((f) => ({ ...f })),
    metrics: [{ downloadCount: 5, thumbsUpCount: 2 }],
    model: { name: 'Model 77', type: 'Checkpoint', nsfw: false, poi: false, mode: null },
  } as any;
}

async function prepare() {
  const mod = await import('~/pages/api/v1/model-versions/[id]');
  return mod.prepareModelVersionResponse(modelVersion(), new URL('https://civitai.com'), [], null);
}

describe('GET /api/v1/model-versions/[id] — per-file downloadUrl is pinned to that file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVaeFiles.mockResolvedValue([]);
    mockGetImages.mockResolvedValue([]);
    mockGetPaidAccess.mockResolvedValue({});
    mockFindUnique.mockResolvedValue(null);
  });

  it('serializes only the Public files', async () => {
    const body = await prepare();
    expect(body!.files.map((f: any) => f.id).sort((a: number, b: number) => a - b)).toEqual([
      21, 22, 23,
    ]);
  });

  it('every file downloadUrl carries the fileId of the file serialized alongside it', async () => {
    const body = await prepare();
    const files = body!.files as any[];
    // Positive control: the loop below must actually run over entries.
    expect(files).toHaveLength(3);

    for (const entry of files) {
      const source = BY_HASH.get(entry.hashes.SHA256);
      expect(source, `unknown SHA256 ${entry.hashes.SHA256}`).toBeDefined();
      expect(entry.sizeKB).toBe(source!.sizeKB);

      const url = new URL(entry.downloadUrl);
      expect(url.pathname).toBe('/api/download/models/4242');
      // THE CONTRACT: the URL resolves to the file whose hash/size were advertised.
      expect(
        url.searchParams.get('fileId'),
        `file ${source!.id} (sha ${source!.hashes[0].hash}) url=${entry.downloadUrl}`
      ).toBe(String(source!.id));
    }
  });

  it('the primary file gets a fileId-pinned URL too, not a bare re-resolvable one', async () => {
    const body = await prepare();
    const files = body!.files as any[];
    const primaryEntry = files.find((f) => f.primary === true);
    expect(primaryEntry).toBeDefined();
    expect(primaryEntry.id).toBe(21);
    expect(primaryEntry.hashes.SHA256).toBe('aaaa1111');
    expect(primaryEntry.downloadUrl).toBe('https://civitai.com/api/download/models/4242?fileId=21');
  });

  it('does not leak type/format/size/fp discriminators into the pinned URL', async () => {
    const body = await prepare();
    for (const entry of body!.files as any[]) {
      const url = new URL(entry.downloadUrl);
      expect([...url.searchParams.keys()]).toEqual(['fileId']);
    }
  });

  it('the version-level downloadUrl remains the unpinned default download', async () => {
    const body = await prepare();
    expect(body!.downloadUrl).toBe('https://civitai.com/api/download/models/4242');
  });
});
