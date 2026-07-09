import { describe, expect, it, vi } from 'vitest';

// The helpers file imports db/client which calls env.LOGGING.filter() at
// module load. Mock the db client before the module is imported so the load
// succeeds. shouldRestampOverrideBasis is a pure predicate — no DB calls
// are made in the tests below.
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {},
}));

import { shouldRestampOverrideBasis } from '~/server/services/article-rating-review.helpers';

describe('shouldRestampOverrideBasis', () => {
  it('restamps when a moderator asserts a non-null override (value changed)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: 4, currentOverride: 8 })
    ).toBe(true);
  });

  it('restamps when a moderator re-affirms the SAME non-null override (the residual case)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: 4, currentOverride: 4 })
    ).toBe(true);
  });

  it('does NOT restamp when the override is being cleared (null) — caller writes null basis', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: null, currentOverride: 4 })
    ).toBe(false);
  });

  it('does NOT restamp when the payload omits the override field (undefined)', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: true, payloadOverride: undefined, currentOverride: 4 })
    ).toBe(false);
  });

  it('does NOT restamp for a non-moderator save', () => {
    expect(
      shouldRestampOverrideBasis({ isModerator: false, payloadOverride: 4, currentOverride: null })
    ).toBe(false);
  });
});
