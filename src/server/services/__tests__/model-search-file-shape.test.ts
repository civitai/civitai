import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));

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

async function run() {
  const result = await runModelSearch(
    { limit: 10 },
    {
      browsingLevel: allBrowsingLevelsFlag,
      nsfwImagePassthrough: true,
      baseUrlOrigin: 'https://civitai.com',
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
