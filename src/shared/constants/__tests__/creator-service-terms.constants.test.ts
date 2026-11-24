import { afterEach, describe, expect, it, vi } from 'vitest';
import { buyerDisclosureItems } from '~/shared/constants/creator-service-terms.constants';

/** The revisions line of the buyer disclosure, as the buyer reads it. */
describe('buyerDisclosureItems price line', () => {
  // The server stores these lines as the buyer's record, so they must not vary with its locale.
  afterEach(() => vi.restoreAllMocks());

  it('groups the price the same way under a de-DE default locale', () => {
    const original = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions
    ) {
      return original.call(this, locales ?? 'de-DE', options);
    });
    // The stub does change the default: a bare call groups the German way.
    expect((1000).toLocaleString()).toBe('1.000');

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
