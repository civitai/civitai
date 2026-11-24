import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buyerDisclosureItems,
  buyerDisclosureLines,
} from '~/shared/constants/creator-service-terms.constants';

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

describe('buyerDisclosureItems ids', () => {
  const items = (reviewEnabled: boolean) =>
    buyerDisclosureItems({ price: 100, revisionsIncluded: 1, deliveryDays: 3, reviewEnabled });

  it('keeps each line under its own id whatever the rollout says', () => {
    const ids = ['hold', 'delivery', 'accept', 'cancel', 'dispute', 'party'];
    expect(items(false).map((item) => item.id)).toEqual(ids);
    expect(items(true).map((item) => item.id)).toEqual(ids);
  });

  it('stores only the lead and text, never the id', () => {
    const lines = buyerDisclosureLines(items(true));
    expect(lines).toHaveLength(6);
    expect(lines.join(' ')).not.toMatch(/\b(hold|delivery|accept|cancel|dispute|party)\b(?=\s*$)/);
    expect(lines[0]).toBe(`${items(true)[0].lead} ${items(true)[0].text}`);
  });
});
