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

  // What a deal stores as the buyer's record, written out so a changed word or a stray id shows.
  const common = [
    "100 Buzz is held now. Refunded if the seller declines, doesn't accept within 48 hours, or you withdraw before they accept.",
    'Delivery within 3 days of acceptance. 1 revision included.',
    "Accept or request an included revision. You can't reject a delivery, but you can ask to cancel. If you do nothing, it completes 72 hours after the latest delivery.",
    "Either side can ask to cancel before completion. You're refunded if the other side agrees or doesn't answer within 48 hours. If they decline, a Civitai moderator decides.",
  ];
  const party =
    "Civitai isn't a party to this deal. Don't pay or share payment details outside Civitai.";
  const stored = {
    reviewOff: [
      ...common,
      'You have 48 hours after completion to dispute. Then the seller is paid. Moderator decisions on disputes and cancellations are final on Civitai.',
      party,
    ],
    reviewOn: [
      ...common,
      'You have 48 hours after completion to dispute. Then the seller is paid. If you review the work as Happy, the seller is paid right away and you can no longer dispute. Moderator decisions on disputes and cancellations are final on Civitai.',
      party,
    ],
  };

  it.each([
    ['without reviews', false, stored.reviewOff],
    ['with reviews', true, stored.reviewOn],
  ])('stores exactly these lines %s', (_label, reviewEnabled, expected) => {
    expect(buyerDisclosureLines(items(reviewEnabled))).toEqual(expected);
  });

  it('never starts or ends a stored line with an item id', () => {
    // The ids are ordinary words in the text, so only an id tacked on to either end can be told apart.
    const ids = items(true).map((item) => item.id);
    for (const line of [
      ...stored.reviewOff,
      ...stored.reviewOn,
      ...buyerDisclosureLines(items(true)),
    ]) {
      for (const id of ids) {
        expect(line.startsWith(id), line).toBe(false);
        expect(line.endsWith(id), line).toBe(false);
      }
    }
  });
});
