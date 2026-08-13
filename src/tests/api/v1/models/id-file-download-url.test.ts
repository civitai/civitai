import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertDownloadUrlsResolve } from '~/tests/api/v1/download-url-seam.helper';

/**
 * Regression coverage for GET /api/v1/models/[id] — per-file `downloadUrl`
 * must resolve to the SAME file whose `hashes` / `sizeKB` / `name` were
 * serialized next to it.
 *
 * The defect: the handler built each file's URL with
 * `createModelFileDownloadUrl({ versionId, type, meta, primary: primaryFile.id === file.id })`.
 * For the file that happened to be primary that emits a BARE
 * `/api/download/models/<versionId>` with no query string at all, which the
 * download route then re-resolves independently (requesting user's
 * filePreferences + its own scoring). On a multi-file version that can land on
 * a DIFFERENT file than the one whose SHA256 the response advertised — an API
 * contract violation for any consumer that verifies the hash.
 *
 * The fix pins each URL to its own file: `{ versionId, fileId: file.id }`.
 *
 * `createModelFileDownloadUrl` is deliberately NOT mocked here (the sibling
 * origin-cache suite stubs it to a constant) — the URL string it produces IS
 * the contract under test. `getPrimaryFile` is also real, so the primary
 * election is the production one.
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));

vi.mock('~/server/services/model-version.service', () => ({
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:${id}:${browsingLevel}`,
}));

// Origin cache is disabled for this suite (IS_DATAPACKET false below), so these
// are never exercised; stubbed only to keep the redis graph out of the suite.
vi.mock('~/server/utils/cache-helpers', () => ({ fetchThroughCache: vi.fn() }));
vi.mock('~/server/redis/client', () => ({
  redis: { packed: { get: vi.fn(), set: vi.fn() }, del: vi.fn() },
  REDIS_KEYS: { CACHES: { PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response' } },
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => handler(req, res),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

// IS_DATAPACKET false ⇒ PUBLIC_MODEL_RESPONSE_TTL = 0 ⇒ every request builds
// directly (no cache), which is what we want to observe.
vi.mock('~/env/server', () => ({
  env: { IS_DATAPACKET: false, LOGGING: '', IS_BUILD: true },
}));

vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
// The serialized `name` is not the subject here; a per-file deterministic name
// keeps the fixture readable while staying distinct per file.
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));

/**
 * Four files on ONE version, values PAIRWISE DISTINCT on every axis the
 * implementation could key off (id, type, format, size, fp, sizeKB, hash) so a
 * mutant that binds the wrong file cannot coincidentally produce the right URL.
 *
 * File 11 is deliberately the one `getPrimaryFile` elects (type 'Model' +
 * SafeTensor/pruned/fp16 = the default preference, highest score) — that is the
 * exact file the old `primary: true` branch emitted a bare, re-resolvable URL for.
 * File 14 is non-Public and must not be serialized at all.
 */
const FILES = [
  {
    id: 11,
    modelVersionId: 4242,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 1111,
    hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  },
  {
    id: 12,
    modelVersionId: 4242,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 2222,
    hashes: [{ type: 'SHA256', hash: 'bbbb2222' }],
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' },
  },
  {
    id: 13,
    modelVersionId: 4242,
    type: 'Config',
    visibility: 'Public',
    sizeKB: 3333,
    hashes: [{ type: 'SHA256', hash: 'cccc3333' }],
    metadata: { format: 'Other' },
  },
  {
    id: 14,
    modelVersionId: 4242,
    type: 'Model',
    visibility: 'Private',
    sizeKB: 4444,
    hashes: [{ type: 'SHA256', hash: 'dddd4444' }],
    metadata: { format: 'GGUF', quantType: 'Q8_0' },
  },
];

/**
 * A file spliced in from the LINKED VAE version. `getModelsWithVersions` does
 * `files.push(...vaeFile)` on the HOST version's array, where `vaeFile` came
 * from `getVaeFiles` — which selects `type: 'Model'` rows on the LINKED version,
 * rewrites `type` to 'VAE', and keeps each row's own `id` AND `modelVersionId`
 * (that select is pinned by
 * src/server/services/__tests__/vae-files-cross-version.test.ts, so this shape
 * is derived from the real producer, not invented here).
 *
 * So `version.files` is NOT "the files of version 4242": entry 91 belongs to
 * 9999. Pinning its id to 4242 emits a pair the download route resolves as
 * `findFirst({ id: 91, modelVersionId: 4242 })` → null → 404.
 */
const LINKED_VAE_VERSION_ID = 9999;
const VAE_FILE = {
  id: 91,
  modelVersionId: LINKED_VAE_VERSION_ID,
  type: 'VAE',
  visibility: 'Public',
  sizeKB: 5555,
  hashes: [{ type: 'SHA256', hash: 'eeee5555' }],
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
};

// hash → the fixture file that hash belongs to. The assertion walks the RESPONSE
// and uses the advertised hash to recover which file the response claims each
// entry is, then checks the URL points at THAT file.
const BY_HASH = new Map(FILES.map((f) => [f.hashes[0].hash, f]));

function modelItem(id: number, { withVae = false }: { withVae?: boolean } = {}) {
  return {
    id,
    name: `Model ${id}`,
    mode: null,
    tagsOnModels: [],
    user: { username: 'creator', image: null, profilePicture: null },
    modelVersions: [
      {
        id: 4242,
        name: 'v1',
        status: 'Published',
        // The literal splice getModelsWithVersions performs.
        files: withVae ? [...FILES, { ...VAE_FILE }] : FILES,
        images: [],
      },
    ],
  };
}

function fakeRes() {
  const res: any = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(id: string) {
  const mod = await import('~/pages/api/v1/models/[id]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query: { id },
    headers: { host: 'civitai.com' },
    url: `/api/v1/models/${id}`,
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('GET /api/v1/models/[id] — per-file downloadUrl is pinned to that file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModelsWithVersions.mockImplementation(async ({ input }: any) => ({
      items: [modelItem(input.ids[0])],
    }));
  });

  it('serializes only the Public files', async () => {
    const res = await invoke('7');
    expect(res.statusCode).toBe(200);
    const files = res.body.modelVersions[0].files;
    expect(files.map((f: any) => f.id).sort((a: number, b: number) => a - b)).toEqual([11, 12, 13]);
  });

  it('every file downloadUrl carries the fileId of the file serialized alongside it', async () => {
    const res = await invoke('7');
    expect(res.statusCode).toBe(200);
    const files = res.body.modelVersions[0].files;
    // Positive control: the assertion loop below must actually run over entries.
    expect(files).toHaveLength(3);

    for (const entry of files) {
      const source = BY_HASH.get(entry.hashes.SHA256);
      // The advertised hash must belong to a real fixture file (guards against a
      // mutant that shuffles hashes rather than URLs).
      expect(source, `unknown SHA256 ${entry.hashes.SHA256}`).toBeDefined();
      // The metadata really is this file's metadata (sizeKB is pairwise distinct).
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
    const res = await invoke('7');
    const files = res.body.modelVersions[0].files;
    // EXACTLY ONE entry may claim `primary` — a mutant that hardcodes the flag
    // (dropping the `primaryFile.id === file.id` identity comparison) marks all
    // three, which is a lie about which file the version's bare default URL
    // resolves to.
    const primaryIds = files.filter((f: any) => f.primary === true).map((f: any) => f.id);
    expect(primaryIds).toEqual([11]);
    const primaryEntry = files.find((f: any) => f.primary === true);
    // File 11 is the elected primary (real getPrimaryFile, default preferences).
    expect(primaryEntry).toBeDefined();
    expect(primaryEntry.id).toBe(11);
    // …and every other entry must explicitly NOT claim it.
    for (const other of files.filter((f: any) => f.id !== 11))
      expect(other.primary, `file ${other.id}`).toBeUndefined();
    expect(primaryEntry.hashes.SHA256).toBe('aaaa1111');
    // This is the file the defect emitted `/api/download/models/4242` for, with
    // NO query string — free to re-resolve to file 12 or 13 at download time.
    expect(primaryEntry.downloadUrl).toBe('https://civitai.com/api/download/models/4242?fileId=11');
  });

  it('does not leak type/format/size/fp discriminators into the pinned URL', async () => {
    // `createModelFileDownloadUrl` suppresses every soft discriminator once
    // `fileId` is supplied; a URL still carrying them would mean the pin is not
    // actually taking the fileId branch.
    const res = await invoke('7');
    for (const entry of res.body.modelVersions[0].files) {
      const url = new URL(entry.downloadUrl);
      expect([...url.searchParams.keys()]).toEqual(['fileId']);
    }
  });

  it('a pinned URL survives a round trip through the download route contract', async () => {
    // The pin is only worth anything if the download route's `fileId` branch
    // treats it as authoritative. Pin what that branch depends on: the URL is a
    // plain `?fileId=<n>` on the version path, i.e. exactly the shape
    // `/api/download/models/[modelVersionId]` parses into `input.fileId` — the
    // input that both selects the file directly (bypassing filePreferences
    // scoring) and skips the metadata-misalignment check.
    const res = await invoke('7');
    for (const entry of res.body.modelVersions[0].files) {
      const url = new URL(entry.downloadUrl);
      const fileId = url.searchParams.get('fileId');
      expect(fileId).toMatch(/^\d+$/);
      expect(Number(fileId)).toBe(entry.id);
    }
  });

  it('the version-level downloadUrl remains the unpinned default download', async () => {
    // Not part of the fix: the version-level URL is the "give me the default
    // file" entry point and advertises no per-file hash, so it stays bare.
    const res = await invoke('7');
    expect(res.body.modelVersions[0].downloadUrl).toBe(
      'https://civitai.com/api/download/models/4242'
    );
  });

  it('does not leak the internal modelVersionId onto the wire body', async () => {
    // getModelsWithVersions now PRESERVES `modelVersionId` on each file so the
    // shaper can tell owned files from spliced ones; the endpoint must strip it
    // again or the public response shape changes.
    const res = await invoke('7');
    for (const entry of res.body.modelVersions[0].files)
      expect(Object.prototype.hasOwnProperty.call(entry, 'modelVersionId')).toBe(false);
  });

  /**
   * The CROSS-VERSION case the pin got wrong: a VAE file belonging to version
   * 9999 sitting in version 4242's file list.
   */
  describe('with a VAE file spliced in from a LINKED version', () => {
    beforeEach(() => {
      mockGetModelsWithVersions.mockImplementation(async ({ input }: any) => ({
        items: [modelItem(input.ids[0], { withVae: true })],
      }));
    });

    it('serializes the spliced VAE file alongside the host version files', async () => {
      const res = await invoke('7');
      const files = res.body.modelVersions[0].files;
      expect(files.map((f: any) => f.id).sort((a: number, b: number) => a - b)).toEqual([
        11, 12, 13, 91,
      ]);
    });

    it('does NOT pin the foreign file id to the host version', async () => {
      const res = await invoke('7');
      const vaeEntry = res.body.modelVersions[0].files.find((f: any) => f.id === 91);
      expect(vaeEntry, 'the spliced VAE file was not serialized').toBeDefined();
      const url = new URL(vaeEntry.downloadUrl);
      expect(url.pathname).toBe('/api/download/models/4242');
      expect(
        url.searchParams.get('fileId'),
        `fileId=91 on version 4242 is the 404 pair — url=${vaeEntry.downloadUrl}`
      ).toBeNull();
      // Keeps the discriminator URL the download route's linked-component
      // fallback resolves (`isComponentFileType('VAE')`).
      expect(url.searchParams.get('type')).toBe('VAE');
    });

    it('still pins every file the host version DOES own', async () => {
      const res = await invoke('7');
      const owned = res.body.modelVersions[0].files.filter((f: any) => f.id !== 91);
      expect(owned).toHaveLength(3);
      for (const entry of owned)
        expect(
          new URL(entry.downloadUrl).searchParams.get('fileId'),
          `owned file ${entry.id} lost its pin`
        ).toBe(String(entry.id));
    });

    it('every emitted (versionId, fileId) pair resolves at the download route', async () => {
      const res = await invoke('7');
      assertDownloadUrlsResolve({
        urls: res.body.modelVersions[0].files.map((f: any) => f.downloadUrl),
        universe: [
          ...FILES.map((f) => ({ id: f.id, modelVersionId: f.modelVersionId })),
          { id: VAE_FILE.id, modelVersionId: VAE_FILE.modelVersionId },
        ],
        expect: expect as never,
      });
    });
  });
});

/**
 * The pin above is only correct because `createModelFileDownloadUrl` treats
 * `fileId` as exclusive: it must emit ONLY `fileId` and suppress every soft
 * discriminator, otherwise a stale `type`/`format`/`size`/`fp`/`quantType` would
 * ride along and the download route's misalignment check could 404 a URL we
 * just advertised. The endpoint suites can't observe this (they no longer pass
 * type/meta at all), so it is pinned here directly.
 */
describe('createModelFileDownloadUrl — `fileId` is exclusive', () => {
  it('suppresses type/format/size/fp/quantType even when they are supplied', async () => {
    const { createModelFileDownloadUrl } = await import('~/server/common/model-helpers');
    const url = new URL(
      `https://x.test${createModelFileDownloadUrl({
        versionId: 4242,
        fileId: 11,
        type: 'Model',
        meta: { format: 'GGUF', size: 'full', fp: 'fp32', quantType: 'Q8_0' },
      })}`
    );
    expect(url.pathname).toBe('/api/download/models/4242');
    expect([...url.searchParams.keys()]).toEqual(['fileId']);
    expect(url.searchParams.get('fileId')).toBe('11');
  });

  it('still emits the discriminators when NO fileId is given (unchanged behavior)', async () => {
    // Positive control for the test above: the suppression really is keyed on
    // `fileId`, not on the helper ignoring these fields outright.
    const { createModelFileDownloadUrl } = await import('~/server/common/model-helpers');
    const url = new URL(
      `https://x.test${createModelFileDownloadUrl({
        versionId: 4242,
        type: 'Model',
        meta: { format: 'GGUF', size: 'full', fp: 'fp32', quantType: 'Q8_0' },
      })}`
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      'format',
      'fp',
      'quantType',
      'size',
      'type',
    ]);
  });
});
