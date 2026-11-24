import { describe, expect, it } from 'vitest';
import { buyerDisclosureItems } from '~/shared/constants/creator-service-terms.constants';

/** The revisions line of the buyer disclosure, as the buyer reads it. */
describe('buyerDisclosureItems price line', () => {
  // The server stores these lines as the buyer's record, so they must not vary with its locale.
  it('groups the price the same way whatever the runtime locale', () => {
    const [{ lead }] = buyerDisclosureItems({
      price: 1000,
      revisionsIncluded: 1,
      deliveryDays: 3,
      reviewEnabled: false,
    });
    expect(lead).toBe('1,000 Buzz is held now.');
  });
});

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
