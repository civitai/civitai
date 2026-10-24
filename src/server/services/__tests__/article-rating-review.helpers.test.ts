import { describe, expect, it, vi } from 'vitest';

import { shouldRestampOverrideBasis } from '~/server/services/article-rating-review.helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
