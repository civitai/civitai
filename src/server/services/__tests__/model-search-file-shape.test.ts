import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toApiModelFile } from '~/server/common/model-helpers';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * `/api/v1/models` (the LIST endpoint) is the SECOND consumer of
 * `getModelsWithVersions`, which now PRESERVES `modelVersionId` on every file so
 * the by-id shaper can tell an owned file from one spliced in off a linked VAE
 * version. This shaper spreads `...file` straight onto the wire body, so it has
 * to strip that field again or an internal column appears on a public response.
 *
 * Nothing else pinned the list endpoint's per-file shape, so a mutation that
 * removed the strip survived the whole suite. This is the guard for it.
 *
 * `createModelFileDownloadUrl` and `getPrimaryFile` are REAL — the emitted URL
 * is asserted too, because this endpoint does NOT pin `fileId` (it still builds
 * discriminator URLs) and that difference should be visible, not incidental.
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: (_label: string, fn: () => unknown) => fn(),
  MeiliCallTimeoutError: class extends Error {},
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
// The listing rule is tested on PGlite (training-data-share.behavior.test.ts); here only that this
// surface asks it with the request's host and applies the answer.
vi.mock('~/server/services/training-data-restricted.service', () => ({
  trainingDataListing:
    async (
      _db: unknown,
      _versions: unknown,
      { redCapable, viewerManages }: { redCapable: boolean; viewerManages?: boolean }
    ) =>
    (file: { type: string }) =>
      file.type !== 'Training Data' || redCapable || !!viewerManages,
}));

import { runModelSearch } from '~/server/services/model-search.service';

const HOST_VERSION_ID = 4242;
const LINKED_VAE_VERSION_ID = 9999;

const FILES = [
  {
    id: 11,
    modelVersionId: HOST_VERSION_ID,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 1111,
    hashes: [{ type: 'SHA256', hash: 'aaaa1111' }],
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  },
  {
    id: 12,
    modelVersionId: HOST_VERSION_ID,
    type: 'Model',
    visibility: 'Public',
    sizeKB: 2222,
    hashes: [{ type: 'SHA256', hash: 'bbbb2222' }],
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' },
  },
  // Spliced off the linked VAE version by getModelsWithVersions.
  {
    id: 91,
    modelVersionId: LINKED_VAE_VERSION_ID,
    type: 'VAE',
    visibility: 'Public',
    sizeKB: 5555,
    hashes: [{ type: 'SHA256', hash: 'eeee5555' }],
    metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
  },
];

function shapedItem() {
  return {
    id: 7,
    name: 'Model 7',
    mode: null,
    tagsOnModels: [],
    user: { username: 'creator', image: null, profilePicture: null },
    modelVersions: [
      {
        id: HOST_VERSION_ID,
        name: 'v1',
        status: 'Published',
        covered: true,
        createdAt: new Date(),
        files: FILES,
        images: [],
      },
    ],
  };
}

async function run(redCapable?: boolean) {
  const result = await runModelSearch(
    { limit: 10 },
    {
      browsingLevel: allBrowsingLevelsFlag,
      nsfwImagePassthrough: true,
      baseUrlOrigin: 'https://civitai.com',
      redCapable,
    }
  );
  return (result.items[0] as any).modelVersions[0].files as any[];
}

describe('runModelSearch (GET /api/v1/models) — per-file wire shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetModelsWithVersions.mockResolvedValue({ items: [shapedItem()], nextCursor: undefined });
  });

  it('serializes every Public file', async () => {
    const files = await run();
    expect(files.map((f) => f.id).sort((a, b) => a - b)).toEqual([11, 12, 91]);
  });

  it('does NOT leak the internal modelVersionId onto the public list body', async () => {
    const files = await run();
    // Positive control: the loop has entries to inspect.
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files)
      expect(
        Object.prototype.hasOwnProperty.call(entry, 'modelVersionId'),
        `file ${entry.id} leaked modelVersionId`
      ).toBe(false);
  });

  it('still strips url/visibility, as before', async () => {
    const files = await run();
    for (const entry of files) {
      expect(entry.url).toBeUndefined();
      expect(entry.visibility).toBeUndefined();
    }
  });

  it('emits discriminator URLs, not fileId pins (this endpoint was NOT changed)', async () => {
    const files = await run();
    for (const entry of files) {
      const url = new URL(entry.downloadUrl);
      expect(url.pathname).toBe(`/api/download/models/${HOST_VERSION_ID}`);
      expect(url.searchParams.get('fileId'), `file ${entry.id}`).toBeNull();
    }
  });
});

describe('runModelSearch (GET /api/v1/models) — a mature training dataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const item = shapedItem();
    item.modelVersions[0].files = [
      ...FILES,
      {
        id: 15,
        modelVersionId: HOST_VERSION_ID,
        type: 'Training Data',
        visibility: 'Public',
        sizeKB: 6666,
        hashes: [],
        metadata: {
          ownRights: true,
          shareDataset: true,
          nsfwLevel: 4,
          fullyRated: true,
          datasetArchive: { items: 3, skipped: 0, complete: true },
          trainingResults: { version: 2, epochs: [{ epochNumber: 1 }] },
        } as any,
      },
    ];
    mockGetModelsWithVersions.mockResolvedValue({ items: [item], nextCursor: undefined });
  });

  it('is left out for a host that is not red-capable, and by default', async () => {
    expect((await run(false)).map((f) => f.id)).not.toContain(15);
    expect((await run()).map((f) => f.id)).not.toContain(15);
  });

  it('is listed for a red-capable host', async () => {
    expect((await run(true)).map((f) => f.id)).toContain(15);
  });
});

describe('runModelSearch (GET /api/v1/models) — a Public training dataset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const item = shapedItem();
    // The real narrowing getModelsWithVersions applies to every file.
    item.modelVersions[0].files = [
      ...FILES,
      {
        ...FILES[0],
        id: 15,
        type: 'Training Data',
        sizeKB: 6666,
        hashes: [],
        metadata: { format: 'Other' },
      },
    ].map(toApiModelFile) as any;
    mockGetModelsWithVersions.mockResolvedValue({ items: [item], nextCursor: undefined });
  });

  it('is listed without its metadata', async () => {
    const file = (await run(true)).find((f) => f.id === 15);
    expect(file).toBeDefined();
    expect(file.metadata).toEqual({});
  });

  it('a model file beside it keeps its metadata', async () => {
    const file = (await run(true)).find((f) => f.id === 11);
    expect(file.metadata).toEqual({ format: 'SafeTensor', size: 'pruned', fp: 'fp16' });
  });
});
