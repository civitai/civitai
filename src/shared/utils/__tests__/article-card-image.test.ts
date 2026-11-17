import { describe, expect, it } from 'vitest';
import { servableArticleImage } from '~/shared/utils/article-card-image';

const image = (
  over: Partial<{ ingestion: string; nsfwLevel: number; needsReview: string | null }>
) => ({
  id: 1,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  needsReview: null as string | null,
  ...over,
});

describe('servableArticleImage', () => {
  it('serves a scanned, rated image not awaiting review', () => {
    expect(servableArticleImage(image({}))?.id).toBe(1);
  });

  it.each([
    ['unrated', { nsfwLevel: 0 }],
    ['unscanned', { ingestion: 'Pending' }],
    ['awaiting review', { needsReview: 'minor' }],
  ])('withholds an image that is %s', (_, over) => {
    expect(servableArticleImage(image(over))).toBeNull();
  });
});
