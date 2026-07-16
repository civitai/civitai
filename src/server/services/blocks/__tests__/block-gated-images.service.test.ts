import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const findMany = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { image: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
// Deterministic edge-url so the assertion is stable and we never import the real
// CF util (which pulls env). The gated url embeds the raw key so we can assert it
// is ONLY ever produced for a visible image.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string, opts?: { width?: number }) => `edge:${url}@${opts?.width}`,
}));

import {
  getBlockGatedImagesByIds,
  resolveViewerBrowsingLevel,
} from '~/server/services/blocks/block-gated-images.service';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const SFW = NsfwLevel.PG | NsfwLevel.PG13; // 3
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
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
});

describe('getBlockGatedImagesByIds', () => {
  it('queries ONLY bare (postId null) rows and preserves request order', async () => {
    findMany.mockResolvedValue([clean(2), clean(1)]); // DB returns out of order
    const { images } = await getBlockGatedImagesByIds({ imageIds: [1, 2], browsingLevel: SFW });

    // postId: null scoping is applied in the where clause.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ postId: null }) })
    );
    // Result is in REQUEST order (1 then 2), not DB order.
    expect(images.map((i) => i.imageId)).toEqual([1, 2]);
  });

  it('projects a visible image with a gated edge url + dims, never the raw key', async () => {
    findMany.mockResolvedValue([clean(1)]);
    const { images } = await getBlockGatedImagesByIds({ imageIds: [1], browsingLevel: SFW });
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
    // The raw key never appears as a bare url.
    expect(JSON.stringify(images)).not.toContain('"url":"key-1"');
  });

  it('returns a HIDDEN entry with NO url for an above-ceiling image', async () => {
    findMany.mockResolvedValue([clean(1, { nsfwLevel: NsfwLevel.R })]);
    const { images } = await getBlockGatedImagesByIds({ imageIds: [1], browsingLevel: SFW });
    expect(images[0]).toEqual({ imageId: 1, status: 'hidden' });
    expect('url' in images[0]).toBe(false);
  });

  it('returns HIDDEN (no url) for unscanned / flagged images', async () => {
    findMany.mockResolvedValue([
      clean(1, { ingestion: ImageIngestionStatus.Pending }),
      clean(2, { needsReview: 'poi' }),
    ]);
    const { images } = await getBlockGatedImagesByIds({ imageIds: [1, 2], browsingLevel: SFW });
    expect(images).toEqual([
      { imageId: 1, status: 'hidden' },
      { imageId: 2, status: 'hidden' },
    ]);
  });

  it('OMITS ids that resolve to no bare row', async () => {
    findMany.mockResolvedValue([clean(1)]); // id 99 not returned
    const { images } = await getBlockGatedImagesByIds({ imageIds: [1, 99], browsingLevel: SFW });
    expect(images.map((i) => i.imageId)).toEqual([1]);
  });

  it('dedupes ids and skips non-positive/non-integer ids without a query for none', async () => {
    findMany.mockResolvedValue([clean(1)]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [1, 1, -5, 0, 3.5 as number],
      browsingLevel: SFW,
    });
    // Only id 1 is a valid id; the query is asked for [1] once.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: [1] } }) })
    );
    expect(images.map((i) => i.imageId)).toEqual([1]);
  });

  it('short-circuits with no query when no valid ids remain', async () => {
    const { images } = await getBlockGatedImagesByIds({ imageIds: [-1, 0], browsingLevel: SFW });
    expect(findMany).not.toHaveBeenCalled();
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
