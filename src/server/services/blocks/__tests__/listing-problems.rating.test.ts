import { describe, expect, it } from 'vitest';

import {
  computeListingProblems,
  type ListingProblemInput,
} from '~/server/services/blocks/listing-problems';

/** Complete in every other dimension, so the rating problem is the only one that can fire. */
const base: ListingProblemInput = {
  kind: 'onsite',
  iconId: 41,
  coverId: 53,
  screenshotCount: 7,
  description: 'A useful app.',
  tagline: 'Does the thing',
  category: 'utility',
  status: 'approved',
  contentRating: 'g',
  declaredContentRating: 'g',
};

const problems = (over: Partial<ListingProblemInput>) =>
  computeListingProblems({ ...base, ...over }).problems;

describe('computeListingProblems — hidden-mature-rating', () => {
  it('an approved listing raised from a declared G to R says it is hidden and points at its images', () => {
    expect(problems({ contentRating: 'r', declaredContentRating: 'g' })).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label:
          'Rated R — hidden on civitai.com (visible on civitai.red). You declared G; a listing is rated at least as high as its most mature store image — check its images',
      },
    ]);
  });

  it('a listing DECLARED mature is hidden too, but is not told its imagery raised it', () => {
    expect(problems({ contentRating: 'x', declaredContentRating: 'x' })).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label: 'Rated X — hidden on civitai.com (visible on civitai.red)',
      },
    ]);
  });

  it('with no declared rating to compare (off-site), reports the hiding alone', () => {
    expect(problems({ kind: 'offsite', contentRating: 'r', declaredContentRating: null })).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label: 'Rated R — hidden on civitai.com (visible on civitai.red)',
      },
    ]);
  });

  it('PG-13 is not mature: raised above a declared G, but not hidden, so no problem', () => {
    expect(problems({ contentRating: 'pg13', declaredContentRating: 'g' })).toEqual([]);
  });

  it.each(['draft', 'pending', 'rejected', 'removed'])(
    'a %s listing is not in the store to be hidden from it',
    (status) => {
      expect(problems({ status, contentRating: 'r', declaredContentRating: 'g' })).toEqual([]);
    }
  );

  it('a null rating is not mature', () => {
    expect(problems({ contentRating: null, declaredContentRating: null })).toEqual([]);
  });
});
