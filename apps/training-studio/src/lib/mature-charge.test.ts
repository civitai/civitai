import { describe, expect, it } from 'vitest';
import { matureAckKey, matureAckMissing, matureSpend } from './mature-charge';

const base = { price: 1400, blue: 384, mode: 'green' as const, mature: false, member: true };

describe('matureSpend', () => {
  it('charges the chosen mode beyond Blue when the dataset is not mature', () => {
    expect(matureSpend(base)).toEqual({
      amount: 1016,
      currency: 'green',
      uncertain: false,
      matureYellow: false,
    });
  });

  it('charges a Green-mode member with a mature dataset in Yellow, Blue first', () => {
    expect(matureSpend({ ...base, mature: true })).toEqual({
      amount: 1016,
      currency: 'yellow',
      uncertain: false,
      matureYellow: true,
    });
  });

  it('charges a non-member the whole price in Yellow, whatever the mode or balance', () => {
    for (const mode of ['yellow', 'green'] as const) {
      expect(matureSpend({ ...base, mode, mature: true, member: false })).toEqual({
        amount: 1400,
        currency: 'yellow',
        uncertain: false,
        matureYellow: true,
      });
    }
  });

  it('needs no acknowledgement when Blue covers a mature member run', () => {
    expect(matureSpend({ ...base, blue: 5000, mature: true })).toBeNull();
  });

  it('fails safe to Yellow when the balance cannot be read', () => {
    expect(matureSpend({ ...base, blue: undefined, mature: true })).toEqual({
      amount: 1400,
      currency: 'yellow',
      uncertain: true,
      matureYellow: true,
    });
  });

  it('needs no acknowledgement when Blue exactly covers a mature member run', () => {
    expect(matureSpend({ ...base, price: 384, mature: true })).toBeNull();
  });

  it('charges a non-member in full even when the balance cannot be read', () => {
    expect(matureSpend({ ...base, blue: undefined, mature: true, member: false })).toEqual({
      amount: 1400,
      currency: 'yellow',
      uncertain: false,
      matureYellow: true,
    });
  });

  it('returns nothing without a price', () => {
    expect(matureSpend({ ...base, price: null, mature: true })).toBeNull();
    expect(matureSpend({ ...base, price: 0, mature: true })).toBeNull();
  });
});

describe('mature acknowledgement', () => {
  const spend = matureSpend({ ...base, mature: true });
  const key = matureAckKey(spend, 3);

  it('requires no tick when no Yellow is charged because of mature images', () => {
    expect(matureAckKey(matureSpend(base), 0)).toBeNull();
    expect(matureAckMissing(null, null)).toBe(false);
    expect(matureAckMissing('1016:3', null)).toBe(false);
  });

  it('blocks start until the current charge is ticked', () => {
    expect(matureAckMissing(null, key)).toBe(true);
    expect(matureAckMissing(key, key)).toBe(false);
  });

  it('un-ticks when the amount or the mature count changes', () => {
    const changedAmount = matureAckKey(matureSpend({ ...base, mature: true, price: 1500 }), 3);
    const changedCount = matureAckKey(spend, 4);
    expect(matureAckMissing(key, changedAmount)).toBe(true);
    expect(matureAckMissing(key, changedCount)).toBe(true);
  });
});
