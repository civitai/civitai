import { describe, expect, it } from 'vitest';
import { buyerDisclosureItems } from '~/shared/constants/creator-service-terms.constants';

/** The revisions line of the buyer disclosure, as the buyer reads it. */
describe('buyerDisclosureItems revisions line', () => {
  const line = (revisionsIncluded: number) => {
    const { lead, text } = buyerDisclosureItems({
      price: 100,
      revisionsIncluded,
      deliveryDays: 3,
      reviewEnabled: false,
    })[1];
    return `${lead} ${text}`;
  };

  it.each([
    [0, 'Delivery within 3 days of acceptance. No revisions included.'],
    [1, 'Delivery within 3 days of acceptance. 1 revision included.'],
    [2, 'Delivery within 3 days of acceptance. 2 revisions included.'],
  ])('with %i revisions reads exactly', (revisionsIncluded, expected) => {
    expect(line(revisionsIncluded)).toBe(expected);
  });
});
