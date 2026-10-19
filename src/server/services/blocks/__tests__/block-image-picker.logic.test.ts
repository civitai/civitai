import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `getEdgeUrl` reads the image CDN base at call time; the real client env module validates the
// whole environment on import.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA' },
}));

import { civitaiHostedImageUrlSchema } from '~/server/schema/blocks/civitai-image-url';
import { DIM_MAX, DIM_MIN } from '~/server/schema/blocks/workflow.schema';
import {
  postedPickableWhere,
  postedPickRendition,
  projectPostedPickableImage,
  type PostedPickableRow,
} from '~/server/services/blocks/block-image-picker.logic';

const KEY = '00000000-0000-4000-8000-000000004711';
const CREATED_AT = new Date('2025-03-15T10:00:00Z');

const row = (over: Partial<PostedPickableRow> = {}): PostedPickableRow => ({
  id: 4711,
  url: KEY,
  width: 3732,
  height: 1982,
  nsfwLevel: 8,
  createdAt: CREATED_AT,
  ...over,
});

describe('postedPickableWhere', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects only the caller's scanned, unflagged images in a published post, at the viewer's levels", () => {
    expect(postedPickableWhere(8123, 7)).toEqual({
      userId: 8123,
      type: 'image',
      ingestion: 'Scanned',
      poi: false,
      minor: false,
      needsReview: null,
      tosViolation: false,
      nsfwLevel: { in: [1, 2, 4] },
      width: { gt: 0 },
      height: { gt: 0 },
      post: { publishedAt: { lte: new Date('2026-03-04T05:06:07.000Z') } },
    });
  });

  it('publicOnly also leaves out images whose post is Private, and changes nothing else', () => {
    const now = new Date('2026-03-04T05:06:07.000Z');
    const { post, ...rest } = postedPickableWhere(8123, 7, { publicOnly: true });
    expect(post).toEqual({ publishedAt: { lte: now }, availability: { not: 'Private' } });
    const { post: _defaultPost, ...defaultRest } = postedPickableWhere(8123, 7);
    expect(rest).toEqual(defaultRest);
  });

  it('publicOnly false is the default query', () => {
    expect(postedPickableWhere(8123, 7, { publicOnly: false })).toEqual(
      postedPickableWhere(8123, 7)
    );
  });

  it.each([
    [1, [1]],
    [3, [1, 2]],
    [12, [4, 8]],
    [31, [1, 2, 4, 8, 16]],
    // The Blocked bit is not a level anyone browses at.
    [63, [1, 2, 4, 8, 16]],
    [32, []],
    [0, []],
  ])('browsing level %i allows exactly the levels %j, never the unrated 0', (level, levels) => {
    expect(postedPickableWhere(8123, level).nsfwLevel).toEqual({ in: levels });
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
  ])('requests %o at the widest rung: %o', (original, expected) => {
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

  it.each([
    // too tall at every rung (96 wide is still 2880 high)
    { width: 100, height: 3000 },
    // too flat at the widest rung, and narrower rungs only make it flatter
    { width: 4000, height: 200 },
    // rounds to a height of 0 at the widest rung
    { width: 5000, height: 1 },
    { width: 1, height: 5000 },
  ])('has no rendition for %o, whose sides fit the bounds at no rung', (original) => {
    expect(postedPickRendition(original)).toBeNull();
  });

  it('never returns a side outside the source-image bounds', () => {
    for (const width of [1, 7, 64, 100, 513, 1200, 2048, 5000, 20000]) {
      for (const height of [1, 7, 64, 100, 513, 1200, 2048, 5000, 20000]) {
        const rendition = postedPickRendition({ width, height });
        if (!rendition) continue;
        for (const side of [rendition.width, rendition.height]) {
          expect(side).toBeGreaterThanOrEqual(DIM_MIN);
          expect(side).toBeLessThanOrEqual(DIM_MAX);
        }
      }
    }
    // Positive control for the loop above: an ordinary size does have a rendition.
    expect(postedPickRendition({ width: 1200, height: 1200 })).toEqual({
      width: 1200,
      height: 1200,
    });
  });
});

describe('projectPostedPickableImage', () => {
  it('returns the rendition url with the size it is requested at, and the stored level', () => {
    expect(projectPostedPickableImage(row())).toEqual({
      imageId: 4711,
      key: KEY,
      url: `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/width=1200/${KEY}.jpeg`,
      width: 1200,
      height: 637,
      nsfwLevel: 8,
      createdAt: CREATED_AT,
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

  it('does not offer an image no rendition fits', () => {
    expect(projectPostedPickableImage(row({ width: 5000, height: 1 }))).toBeNull();
    expect(projectPostedPickableImage(row({ width: 100, height: 3000 }))).toBeNull();
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
