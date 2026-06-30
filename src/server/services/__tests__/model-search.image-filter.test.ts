import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Non-mocked regression test for the per-image browsingLevel filter inside the
 * REAL `runModelSearch` (the shared body behind both `/api/v1/models` and the
 * App Blocks catalog endpoint `/api/v1/blocks/models`).
 *
 * The endpoint-wiring tests (`src/tests/api/v1/blocks/models-endpoint.test.ts`,
 * `.../models/index-refactor.test.ts`) MOCK `runModelSearch`, so they only prove
 * the handler passes the clamped `browsingLevel` + `nsfwImagePassthrough:false`.
 * They NEVER exercise the actual image filter — which is exactly where the bug
 * lived: it used `Flags.hasFlag` (a SUPERSET test) so a multi-bit browsingLevel
 * like `sfwBrowsingLevelsFlag` (PG|PG13 = 3) dropped EVERY single-bit image
 * (`nsfwLevel & 3 === 3` is never true for a single bit) → empty image arrays
 * for the block catalog AND region-restricted public viewers.
 *
 * This test runs the real filter by mocking ONLY the data layer
 * (`getModelsWithVersions`) and asserting which images survive. It FAILS against
 * `Flags.hasFlag` and PASSES with `Flags.intersects`.
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

// Data layer — the single thing we stub; everything downstream (the per-image
// filter under test) runs for real.
vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));

// Heavy / IO-bound collaborators that the service imports at module load but
// that this filter test never needs to drive — mocked so importing the service
// stays light and Prisma/Meili/env are never loaded.
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: vi.fn(),
  MeiliCallTimeoutError: class extends Error {},
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: vi.fn(() => 'model.safetensors'),
}));
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string) => url,
}));
vi.mock('~/server/common/model-helpers', () => ({
  createModelFileDownloadUrl: vi.fn(() => '/download'),
}));

// A single model with one published version carrying a valid primary file and
// one image at the given nsfwLevel. getPrimaryFile needs a recognized file type
// (e.g. 'Model') or the version is dropped before the image filter runs.
function fakeModelWith(imageNsfwLevels: number[]) {
  return [
    {
      id: 1,
      mode: null,
      tagsOnModels: [],
      user: undefined,
      modelVersions: [
        {
          id: 11,
          status: 'Published',
          covered: true,
          createdAt: new Date(),
          files: [
            {
              id: 101,
              type: 'Model',
              visibility: 'Public',
              metadata: {},
              hashes: [],
              name: 'model.safetensors',
              sizeKB: 1,
            },
          ],
          images: imageNsfwLevels.map((nsfwLevel, i) => ({
            id: 1000 + i,
            url: `img-${i}`,
            nsfwLevel,
            type: 'image',
          })),
        },
      ],
    },
  ];
}

async function run(browsingLevel: number, nsfwImagePassthrough: boolean, imageNsfwLevels: number[]) {
  mockGetModelsWithVersions.mockResolvedValue({
    items: fakeModelWith(imageNsfwLevels),
    nextCursor: undefined,
  });
  const { runModelSearch } = await import('~/server/services/model-search.service');
  const res = await runModelSearch(
    { limit: 10 },
    {
      browsingLevel,
      nsfwImagePassthrough,
      user: undefined,
      baseUrlOrigin: 'https://civitai.com',
    } as Parameters<typeof runModelSearch>[1]
  );
  // Single model → single version → its (filtered) image nsfwLevels.
  const item = res.items[0] as { modelVersions: Array<{ images: Array<{ nsfwLevel: number }> }> };
  return item.modelVersions[0].images.map((img) => img.nsfwLevel);
}

describe('runModelSearch — per-image browsingLevel filter (real Flags)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a PG image under a multi-bit SFW browsingLevel (regression: hasFlag dropped it)', async () => {
    // sfwBrowsingLevelsFlag = PG|PG13 = 3 (multi-bit). With hasFlag this asserts
    // (1 | 3) === 1 → false → the PG image is dropped → EMPTY. With intersects
    // (1 & 3) !== 0 → true → survives. This is THE regression guard.
    const survived = await run(sfwBrowsingLevelsFlag, false, [NsfwLevel.PG]);
    expect(survived).toEqual([NsfwLevel.PG]);
  });

  it('keeps a PG13 image under the same multi-bit SFW browsingLevel', async () => {
    const survived = await run(sfwBrowsingLevelsFlag, false, [NsfwLevel.PG13]);
    expect(survived).toEqual([NsfwLevel.PG13]);
  });

  it('keeps both PG and PG13 images, in one version, under SFW level', async () => {
    const survived = await run(sfwBrowsingLevelsFlag, false, [NsfwLevel.PG, NsfwLevel.PG13]);
    expect(survived).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
  });

  it('drops a mature (R) image under the SFW level — no over-widening', async () => {
    // R = 4 is outside SFW (3). intersects(4, 3) === false → dropped.
    const survived = await run(sfwBrowsingLevelsFlag, false, [NsfwLevel.PG, NsfwLevel.R]);
    expect(survived).toEqual([NsfwLevel.PG]);
  });

  it('nsfwImagePassthrough=true keeps everything (short-circuit unchanged)', async () => {
    const survived = await run(sfwBrowsingLevelsFlag, true, [
      NsfwLevel.PG,
      NsfwLevel.R,
      NsfwLevel.XXX,
    ]);
    expect(survived).toEqual([NsfwLevel.PG, NsfwLevel.R, NsfwLevel.XXX]);
  });

  it('single-bit browsingLevel (legacy public default) still behaves correctly', async () => {
    // browsingLevel = PG = 1 (single bit). hasFlag and intersects are identical
    // here: PG survives, PG13/R do not.
    const survived = await run(NsfwLevel.PG, false, [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R]);
    expect(survived).toEqual([NsfwLevel.PG]);
  });
});
