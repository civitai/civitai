import { describe, expect, it } from 'vitest';
import {
  carouselSource,
  showcaseOptOutChanged,
} from '~/shared/constants/version-showcase.constants';

// A change refreshes every showcase featuring the user's images, so it must fire on a real change only.
describe('showcaseOptOutChanged', () => {
  it('is true when the user opts out or back in', () => {
    expect(showcaseOptOutChanged({}, { hideFromVersionShowcases: true })).toBe(true);
    expect(
      showcaseOptOutChanged({ hideFromVersionShowcases: true }, { hideFromVersionShowcases: false })
    ).toBe(true);
  });

  it('is false when the value did not change, or another setting was written', () => {
    expect(
      showcaseOptOutChanged({ hideFromVersionShowcases: true }, { hideFromVersionShowcases: true })
    ).toBe(false);
    expect(showcaseOptOutChanged({}, { hideFromVersionShowcases: false })).toBe(false);
    expect(showcaseOptOutChanged({ hideFromVersionShowcases: true }, {})).toBe(false);
  });
});

describe('carouselSource: what the model-page carousel serves', () => {
  const source = (showcaseIds: number[] | null, versionCacheFlag = false) =>
    carouselSource({ prioritizeUser: true, versionCacheFlag, showcaseIds });

  it("serves a version's curated list, even with the version-cache flag off", () => {
    expect(source([30, 10, 20])).toBe('curated');
    expect(source([30, 10, 20], true)).toBe('curated');
  });

  it('serves nothing, not an unfiltered page, when the curated list is empty', () => {
    expect(source([])).toBe('empty');
  });

  it('keeps today’s carousel when the version has no curated list', () => {
    expect(source(null)).toBe('live');
    expect(source(null, true)).toBe('version-cache');
  });

  it('is not the carousel without prioritized users', () => {
    expect(
      carouselSource({ prioritizeUser: false, versionCacheFlag: true, showcaseIds: [1] })
    ).toBe('none');
  });
});
