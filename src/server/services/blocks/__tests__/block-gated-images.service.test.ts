import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const queryRaw = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));
// Deterministic edge-url so the assertion is stable and we never import the real
// CF util (which pulls env). The gated url embeds the raw key so we can assert it
// is ONLY ever produced for a visible image.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string, opts?: { width?: number }) => `edge:${url}@${opts?.width}`,
}));
// Viewer hidden-preferences — default: nothing blocked. Overridden per test.
const getAllHiddenForUser = vi.fn(async () => ({
  hiddenUsers: [] as Array<{ id: number }>,
  blockedUsers: [] as Array<{ id: number }>,
  blockedByUsers: [] as Array<{ id: number }>,
  hiddenTags: [] as Array<{ id: number; hidden: boolean }>,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: (...a: unknown[]) => getAllHiddenForUser(...(a as [])),
}));
// The service imports the provenance-marker const from block-image-upload.service;
// stub it so the test doesn't pull that module's env/s3 graph.
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  BLOCK_PUBLISHED_APP_ID_META_KEY: 'blockPublishedAppId',
}));

import {
  getBlockGatedImagesByIds,
  resolveViewerBrowsingLevel,
} from '~/server/services/blocks/block-gated-images.service';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const SFW = NsfwLevel.PG | NsfwLevel.PG13; // 3
const APP = 'app_test';
const clean = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  url: `key-${id}`,
  nsfwLevel: NsfwLevel.PG,
  ingestion: ImageIngestionStatus.Scanned,
  width: 512,
  height: 512,
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  acceptableMinor: false,
  blockedFor: null,
  ...over,
});

// Flatten a $queryRaw tagged-template call's substitution values (everything
// after the TemplateStringsArray) so we can assert the app scope was bound.
function rawSubstitutions() {
  const call = queryRaw.mock.calls[0];
  return call ? call.slice(1) : [];
}

beforeEach(() => {
  queryRaw.mockReset();
  getAllHiddenForUser.mockReset();
  getAllHiddenForUser.mockResolvedValue({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [],
  });
});

describe('getBlockGatedImagesByIds', () => {
  it('scopes the read to the caller appId + preserves request order', async () => {
    queryRaw.mockResolvedValue([clean(2), clean(1)]); // DB returns out of order
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1, 2],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    // The appId (provenance scope) is bound into the query substitutions.
    expect(rawSubstitutions()).toContain(APP);
    // Result is in REQUEST order (1 then 2), not DB order.
    expect(images.map((i) => i.imageId)).toEqual([1, 2]);
    // The viewer's blocked sets are sourced for the clamp.
    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: 42 });
  });

  it('projects a visible image with a gated edge url + dims, never the raw key', async () => {
    queryRaw.mockResolvedValue([clean(1)]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(images[0]).toEqual({
      imageId: 1,
      status: 'visible',
      nsfwLevel: NsfwLevel.PG,
      // contentRatingFromNsfwLevel(PG) is the offsite 'g' rating (SFW floor).
      contentRating: 'g',
      url: 'edge:key-1@1200',
      width: 512,
      height: 512,
    });
    expect(JSON.stringify(images)).not.toContain('"url":"key-1"');
  });

  it('returns a HIDDEN entry with NO url for an above-ceiling image', async () => {
    queryRaw.mockResolvedValue([clean(1, { nsfwLevel: NsfwLevel.R })]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(images[0]).toEqual({ imageId: 1, status: 'hidden' });
    expect('url' in images[0]).toBe(false);
  });

  it('returns HIDDEN (no url) for unscanned / flagged / hard-blocked images', async () => {
    queryRaw.mockResolvedValue([
      clean(1, { ingestion: ImageIngestionStatus.Pending }),
      clean(2, { needsReview: 'poi' }),
      clean(3, { blockedFor: 'CSAM' }),
    ]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1, 2, 3],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(images).toEqual([
      { imageId: 1, status: 'hidden' },
      { imageId: 2, status: 'hidden' },
      { imageId: 3, status: 'hidden' },
    ]);
  });

  it('OMITS ids that resolve to no in-scope row (wrong app / blocked / nonexistent)', async () => {
    queryRaw.mockResolvedValue([clean(1)]); // id 99 not returned by the scoped query
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1, 99],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(images.map((i) => i.imageId)).toEqual([1]);
  });

  it('dedupes ids and skips non-positive/non-integer ids', async () => {
    queryRaw.mockResolvedValue([clean(1)]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1, 1, -5, 0, 3.5 as number],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(rawSubstitutions()).toContainEqual([1]); // only id 1 queried
    expect(images.map((i) => i.imageId)).toEqual([1]);
  });

  it('short-circuits with no query when no valid ids remain', async () => {
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [-1, 0],
      browsingLevel: SFW,
      appId: APP,
      userId: 42,
    });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(getAllHiddenForUser).not.toHaveBeenCalled();
    expect(images).toEqual([]);
  });
});

describe('resolveViewerBrowsingLevel', () => {
  it('fails closed to the public (PG) floor for an absent/zero ceiling', () => {
    expect(resolveViewerBrowsingLevel(undefined)).toBe(publicBrowsingLevelsFlag);
    expect(resolveViewerBrowsingLevel(null)).toBe(publicBrowsingLevelsFlag);
    expect(resolveViewerBrowsingLevel(0)).toBe(publicBrowsingLevelsFlag);
  });
});
