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

  it('a raise from PG-13 to X names both ratings', () => {
    expect(problems({ contentRating: 'x', declaredContentRating: 'pg13' })).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label:
          'Rated X — hidden on civitai.com (visible on civitai.red). You declared PG-13; a listing is rated at least as high as its most mature store image — check its images',
      },
    ]);
  });

  it('a listing DECLARED mature is hidden by the author’s own choice: not a problem', () => {
    expect(problems({ contentRating: 'x', declaredContentRating: 'x' })).toEqual([]);
    expect(problems({ contentRating: 'x', declaredContentRating: 'r' })).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label:
          'Rated X — hidden on civitai.com (visible on civitai.red). You declared R; a listing is rated at least as high as its most mature store image — check its images',
      },
    ]);
    expect(problems({ contentRating: 'r', declaredContentRating: 'r' })).toEqual([]);
  });

  it('with no declared rating to compare (off-site) there is no raise to report', () => {
    expect(problems({ kind: 'offsite', contentRating: 'r', declaredContentRating: null })).toEqual(
      []
    );
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
