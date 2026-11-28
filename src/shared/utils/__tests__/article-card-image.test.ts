import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import { describe, expect, it } from 'vitest';
import { servableArticleImage } from '~/shared/utils/article-card-image';

type Image = Pick<
  Selectable<DB['Image']>,
  'id' | 'ingestion' | 'nsfwLevel' | 'needsReview' | 'modelRestricted'
>;

const image = (over: Partial<Image>): Image => ({
  id: 1,
  ingestion: 'Scanned',
  nsfwLevel: 1,
  needsReview: null,
  modelRestricted: false,
  ...over,
});

describe('servableArticleImage', () => {
  it('serves a scanned, rated image not awaiting review', () => {
    expect(servableArticleImage(image({}))?.id).toBe(1);
  });

  it('serves an image at the highest browsable level', () => {
    expect(servableArticleImage(image({ nsfwLevel: 16 }))?.id).toBe(1);
  });

  it.each([
    ['unrated', { nsfwLevel: 0 }],
    ['rated Blocked', { nsfwLevel: 32 }],
    ['unscanned', { ingestion: 'Pending' }],
    ['awaiting review', { needsReview: 'minor' }],
    ['mature and restricted by its base model', { nsfwLevel: 4, modelRestricted: true }],
  ] as [string, Partial<Image>][])('withholds an image that is %s', (_, over) => {
    expect(servableArticleImage(image(over))).toBeNull();
  });
});
