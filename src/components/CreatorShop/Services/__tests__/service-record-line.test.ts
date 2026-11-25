import { describe, expect, it } from 'vitest';
import { sellerRecordLine } from '~/components/CreatorShop/Services/creator-service.util';

describe('sellerRecordLine', () => {
  it('says how many deals and what share were on time', () => {
    expect(sellerRecordLine({ completed: 12, onTime: 9 })).toBe('12 deals · 75% on time');
  });

  it('rounds the share and uses the singular for one deal', () => {
    expect(sellerRecordLine({ completed: 1, onTime: 1 })).toBe('1 deal · 100% on time');
    expect(sellerRecordLine({ completed: 3, onTime: 2 })).toBe('3 deals · 67% on time');
  });

  it('is null for a seller with no finished deals, so the card has no footer', () => {
    expect(sellerRecordLine({ completed: 0, onTime: 0 })).toBeNull();
  });
});
