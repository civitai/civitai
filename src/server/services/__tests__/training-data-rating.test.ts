import { describe, expect, it } from 'vitest';
import { datasetRating } from '~/server/services/training-data-rating';
import { NsfwLevel } from '~/server/common/enums';

describe('datasetRating', () => {
  it('ORs the levels of the media entries and is fully rated when each has one', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'image', nsfwLevel: 'r' },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG | NsfwLevel.R, fullyRated: true });
  });

  it('ignores caption entries, so a captioned PG zip is fully rated', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'text', nsfwLevel: null },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: true });
  });

  it('is not fully rated when one media entry has no level', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'image', nsfwLevel: null },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: false });
  });

  it('is not fully rated with no media entries at all', () => {
    expect(datasetRating([{ mediaType: 'text' }])).toEqual({
      nsfwLevel: undefined,
      fullyRated: false,
    });
  });

  it('treats an unknown level as unrated', () => {
    expect(datasetRating([{ mediaType: 'image', nsfwLevel: 'unknown' }])).toEqual({
      nsfwLevel: undefined,
      fullyRated: false,
    });
  });
});
