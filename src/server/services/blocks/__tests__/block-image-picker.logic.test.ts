import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `getEdgeUrl` reads the image CDN base at call time; the real client env module validates the
// whole environment on import.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import {
  POSTED_PICKABLE_NSFW_LEVELS,
  postedPickableWhere,
  postedPickRendition,
  projectPostedPickableImage,
  type PostedPickableRow,
} from '~/server/services/blocks/block-image-picker.logic';
import { classifyBlockImageUploadScan } from '~/server/services/blocks/block-image-upload.logic';

const KEY = '00000000-0000-4000-8000-000000004711';

const row = (over: Partial<PostedPickableRow> = {}): PostedPickableRow => ({
  id: 4711,
  url: KEY,
  width: 3732,
  height: 1982,
  nsfwLevel: 2,
  ingestion: 'Scanned',
  needsReview: null,
  poi: false,
  minor: false,
  tosViolation: false,
  ...over,
});

describe('POSTED_PICKABLE_NSFW_LEVELS', () => {
  it('is exactly the levels with no bit above PG-13', () => {
    expect(POSTED_PICKABLE_NSFW_LEVELS).toEqual([0, 1, 2, 3]);
  });

  it('agrees with the upload gate on every level a scanned, unflagged image can carry', () => {
    for (let nsfwLevel = 0; nsfwLevel < 64; nsfwLevel++) {
      const ready = classifyBlockImageUploadScan(row({ nsfwLevel })).status === 'ready';
      expect(POSTED_PICKABLE_NSFW_LEVELS.includes(nsfwLevel)).toBe(ready);
    }
  });
});

describe('postedPickableWhere', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects only the caller's scanned, unflagged, SFW images in a published post", () => {
    expect(postedPickableWhere(8123)).toEqual({
      userId: 8123,
      type: 'image',
      ingestion: 'Scanned',
      poi: false,
      minor: false,
      needsReview: null,
      tosViolation: false,
      nsfwLevel: { in: [0, 1, 2, 3] },
      width: { gt: 0 },
      height: { gt: 0 },
      post: { publishedAt: { lte: new Date('2026-03-04T05:06:07.000Z') } },
    });
  });
});

describe('postedPickRendition', () => {
  // Each pair was read off the image CDN: the stored size of a public image, and the size of the
  // file it returned for the requested width.
  it.each([
    [
      { width: 3732, height: 1982 },
      { width: 1200, height: 637 },
    ],
    [
      { width: 832, height: 1216 },
      { width: 1200, height: 1754 },
    ],
    [
      { width: 1216, height: 832 },
      { width: 1200, height: 821 },
    ],
  ])('serves %o at the widest rung: %o', (original, expected) => {
    expect(postedPickRendition(original)).toEqual(expected);
  });

  it.each([
    [
      { width: 768, height: 1360 },
      { width: 800, height: 1417 },
    ],
    [
      { width: 1048, height: 2248 },
      { width: 800, height: 1716 },
    ],
  ])('steps %o down a rung so the height fits a source image: %o', (original, expected) => {
    expect(postedPickRendition(original)).toEqual(expected);
  });

  it('keeps stepping down for a very tall image', () => {
    expect(postedPickRendition({ width: 500, height: 9000 })).toEqual({ width: 96, height: 1728 });
  });

  it('falls back to the widest rung when no rung fits the source-image bounds', () => {
    expect(postedPickRendition({ width: 100, height: 3000 })).toEqual({
      width: 1200,
      height: 36000,
    });
    expect(postedPickRendition({ width: 4000, height: 200 })).toEqual({ width: 1200, height: 60 });
  });

  it('stays inside the source-image bounds for ordinary aspect ratios', () => {
    for (const [width, height] of [
      [512, 512],
      [640, 1536],
      [1536, 640],
      [1024, 1792],
      [2048, 2048],
      [5000, 3000],
      [300, 1000],
    ]) {
      const rendition = postedPickRendition({ width, height });
      for (const side of [rendition.width, rendition.height]) {
        expect(side).toBeGreaterThanOrEqual(DIM_MIN);
        expect(side).toBeLessThanOrEqual(DIM_MAX);
      }
    }
  });
});

describe('projectPostedPickableImage', () => {
  it('returns the rendition url with the size of the image at that url', () => {
    expect(projectPostedPickableImage(row())).toEqual({
      imageId: 4711,
      key: KEY,
      url: `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/width=1200/${KEY}.jpeg`,
      width: 1200,
      height: 637,
      nsfwLevel: 2,
    });
  });

  it('requests the stepped-down width it reports', () => {
    expect(projectPostedPickableImage(row({ width: 768, height: 1360 }))).toMatchObject({
      url: `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/width=800/${KEY}.jpeg`,
      width: 800,
      height: 1417,
    });
  });

  it('returns a url a generation sourceImage accepts', () => {
    const projected = projectPostedPickableImage(row());
    expect(civitaiHostedImageUrlSchema.safeParse(projected?.url)).toEqual({
      success: true,
      data: projected?.url,
    });
  });

  it('does not offer an image above the SFW ceiling', () => {
    for (const nsfwLevel of [4, 8, 16, 32, 6]) {
      expect(projectPostedPickableImage(row({ nsfwLevel }))).toBeNull();
    }
  });

  it('does not offer an image whose scan is not complete', () => {
    for (const ingestion of [
      'Pending',
      'Error',
      'Blocked',
      'NotFound',
      'PendingManualAssignment',
    ]) {
      expect(
        projectPostedPickableImage(row({ ingestion: ingestion as PostedPickableRow['ingestion'] }))
      ).toBeNull();
    }
  });

  it('does not offer a flagged image', () => {
    expect(projectPostedPickableImage(row({ needsReview: 'minor' }))).toBeNull();
    expect(projectPostedPickableImage(row({ poi: true }))).toBeNull();
    expect(projectPostedPickableImage(row({ minor: true }))).toBeNull();
    expect(projectPostedPickableImage(row({ tosViolation: true }))).toBeNull();
  });

  it('does not offer an image with no stored size', () => {
    expect(projectPostedPickableImage(row({ width: null }))).toBeNull();
    expect(projectPostedPickableImage(row({ height: null }))).toBeNull();
    expect(projectPostedPickableImage(row({ width: 0 }))).toBeNull();
  });

  it('does not offer an image stored as an absolute url, which is served unresized', () => {
    expect(
      projectPostedPickableImage(row({ url: 'https://image.civitai.com/legacy/abc.jpeg' }))
    ).toBeNull();
  });
});
