import { describe, expect, it, vi } from 'vitest';

import {
  computeListingProblems,
  type ListingProblemCode,
  type ListingProblemInput,
} from '~/server/services/blocks/listing-problems';

/**
 * Advisory listing-completeness helper tests. `computeListingProblems` is the
 * AUTHORITATIVE gate for the /apps/my-submissions warning icon — it enumerates a
 * listing's problems (missing assets via the shared `checkListingAssetsComplete`
 * gate + empty key text fields). Pure; no DB/network. The db client is mocked
 * only because the reused assets-service module imports it at load time.
 */

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

/** A fully-complete listing (no problems). Spread + override per case. */
const complete: ListingProblemInput = {
  iconId: 10,
  coverId: 20,
  screenshotCount: 3,
  description: 'A useful app that does a thing.',
  tagline: 'Does the thing',
  category: 'utility',
};

const codes = (input: ListingProblemInput): ListingProblemCode[] =>
  computeListingProblems(input).problems.map((p) => p.code);

describe('computeListingProblems', () => {
  it('returns NO problems for an all-complete listing', () => {
    const result = computeListingProblems(complete);
    expect(result.problems).toEqual([]);
  });

  it('flags a missing icon', () => {
    expect(codes({ ...complete, iconId: null })).toEqual(['missing-icon']);
  });

  it('flags a missing cover', () => {
    expect(codes({ ...complete, coverId: null })).toEqual(['missing-cover']);
  });

  it('flags zero screenshots', () => {
    expect(codes({ ...complete, screenshotCount: 0 })).toEqual(['no-screenshots']);
  });

  it('does NOT flag screenshots when count is positive', () => {
    expect(codes({ ...complete, screenshotCount: 1 })).toEqual([]);
  });

  describe('empty description', () => {
    it('flags null', () => {
      expect(codes({ ...complete, description: null })).toEqual(['empty-description']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, description: '   \n\t ' })).toEqual(['empty-description']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, description: 'hi' })).toEqual([]);
    });
  });

  describe('empty tagline', () => {
    it('flags null', () => {
      expect(codes({ ...complete, tagline: null })).toEqual(['empty-tagline']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, tagline: '  ' })).toEqual(['empty-tagline']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, tagline: 'ok' })).toEqual([]);
    });
  });

  describe('empty category', () => {
    it('flags null', () => {
      expect(codes({ ...complete, category: null })).toEqual(['empty-category']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, category: '\t' })).toEqual(['empty-category']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, category: 'games' })).toEqual([]);
    });
  });

  it('flags EVERY problem for a fully-empty listing, in a stable order', () => {
    const result = computeListingProblems({
      iconId: null,
      coverId: null,
      screenshotCount: 0,
      description: null,
      tagline: '   ',
      category: null,
    });
    expect(result.problems.map((p) => p.code)).toEqual([
      'missing-icon',
      'missing-cover',
      'no-screenshots',
      'empty-description',
      'empty-tagline',
      'empty-category',
    ]);
    // Every problem carries a human-readable, non-empty label.
    for (const p of result.problems) {
      expect(p.label).toBeTypeOf('string');
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('combines a missing asset with an empty field', () => {
    expect(codes({ ...complete, coverId: null, tagline: '' })).toEqual([
      'missing-cover',
      'empty-tagline',
    ]);
  });
});
