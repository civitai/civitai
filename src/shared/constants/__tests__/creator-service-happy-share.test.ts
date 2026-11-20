import { describe, expect, it } from 'vitest';
import { serviceHappyShare } from '~/shared/constants/creator-service.constants';

describe('serviceHappyShare', () => {
  it('shows no share until three buyers count, then a whole percent', () => {
    expect(serviceHappyShare([{ happyCount: 2, reviewCount: 2 }])).toBeNull();
    expect(serviceHappyShare([{ happyCount: 2, reviewCount: 3 }])).toEqual({
      percent: 67,
      reviews: 3,
    });
  });

  it("sums a seller's offerings, so two offerings of two reviews each reach the bar", () => {
    expect(
      serviceHappyShare([
        { happyCount: 2, reviewCount: 2 },
        { happyCount: 1, reviewCount: 2 },
      ])
    ).toEqual({ percent: 75, reviews: 4 });
  });
});
