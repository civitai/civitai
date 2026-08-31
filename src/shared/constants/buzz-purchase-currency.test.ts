import { describe, expect, it } from 'vitest';
import {
  buzzPurchaseTypes,
  coercePurchasedBuzzType,
  deriveDomainBuzzType,
} from '~/shared/constants/buzz.constants';
import { colorDomainNames } from '~/shared/constants/domain.constants';

/**
 * The two halves of "a real-money Buzz purchase is credited in a currency the buyer actually paid
 * for": derive the colour from the domain when the intent is created, and narrow whatever comes
 * back off the provider's metadata when it is credited.
 */

describe('deriveDomainBuzzType', () => {
  it('sells green Buzz on the green domain and yellow everywhere else', () => {
    expect(colorDomainNames.map(deriveDomainBuzzType)).toEqual(
      // green, blue, red — asserted through the real domain list so a new colour lands here rather
      // than silently defaulting to yellow.
      ['green', 'yellow', 'yellow']
    );
  });

  it('only ever returns a currency that is actually for sale', () => {
    for (const domain of colorDomainNames) {
      expect(buzzPurchaseTypes).toContain(deriveDomainBuzzType(domain));
    }
  });
});

describe('coercePurchasedBuzzType', () => {
  it('credits blue — the FREE currency — as yellow, however it got into the metadata', () => {
    expect(coercePurchasedBuzzType('blue')).toBe('yellow');
  });

  it('keeps green and passes everything else through as yellow', () => {
    expect(coercePurchasedBuzzType('green')).toBe('green');
    expect(coercePurchasedBuzzType('yellow')).toBe('yellow');
    expect(coercePurchasedBuzzType('red')).toBe('yellow');
    expect(coercePurchasedBuzzType(undefined)).toBe('yellow');
    expect(coercePurchasedBuzzType('GREEN')).toBe('yellow');
  });
});
