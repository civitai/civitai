import { describe, expect, it } from 'vitest';
import { datasetCharge, matureSpend, spendOrder } from './mature-charge';

describe('spendOrder', () => {
  it('spends Blue first by default, then the paid account', () => {
    expect(spendOrder('yellow', true)).toEqual(['blue', 'yellow']);
  });

  it('a paid-only choice charges the paid account only, never Blue', () => {
    expect(spendOrder('yellow', false)).toEqual(['yellow']);
    expect(spendOrder('green', false)).toEqual(['green']);
  });
});

const base = { price: 1400, blue: 384, mode: 'green' as const, mature: false };

describe('matureSpend', () => {
  it('charges the chosen mode beyond Blue when the dataset is not mature', () => {
    expect(matureSpend(base)).toEqual({ amount: 1016, currency: 'green', uncertain: false });
  });

  it('charges a mature dataset in Yellow beyond Blue, never Green', () => {
    expect(matureSpend({ ...base, mature: true })).toEqual({
      amount: 1016,
      currency: 'yellow',
      uncertain: false,
    });
  });

  it('lets Blue cover a mature dataset in full, so nothing comes out of a paid account', () => {
    expect(matureSpend({ ...base, blue: 5000, mature: true })).toBeNull();
    expect(matureSpend({ ...base, price: 384, mature: true })).toBeNull();
  });

  it('fails safe to the full price when the balance cannot be read', () => {
    expect(matureSpend({ ...base, blue: undefined, mature: true })).toEqual({
      amount: 1400,
      currency: 'yellow',
      uncertain: true,
    });
  });

  it('returns nothing without a price', () => {
    expect(matureSpend({ ...base, price: null, mature: true })).toBeNull();
    expect(matureSpend({ ...base, price: 0, mature: true })).toBeNull();
  });
});

describe('datasetCharge', () => {
  const table: [number, number, boolean, boolean, ReturnType<typeof datasetCharge>][] = [
    [0, 0, false, false, 'not-mature'],
    [0, 0, false, true, 'not-mature'],
    [0, 0, true, false, 'not-mature'],
    [0, 0, true, true, 'not-mature'],
    [0, 2, false, false, 'not-mature'],
    [0, 2, false, true, 'unreadable'],
    [0, 2, true, false, 'mature'],
    [0, 2, true, true, 'mature'],
    [3, 0, false, false, 'mature'],
    [3, 0, false, true, 'reprice'],
    [3, 0, true, false, 'mature'],
    [3, 0, true, true, 'mature'],
    [3, 2, false, false, 'mature'],
    [3, 2, false, true, 'reprice'],
    [3, 2, true, false, 'mature'],
    [3, 2, true, true, 'mature'],
  ];
  it.each(table)(
    'mature %i, failed %i, priced mature %s, spends Green %s → %s',
    (mature, failed, pricedMature, spendsGreen, charge) => {
      expect(datasetCharge({ mature, failed, pricedMature, spendsGreen })).toBe(charge);
    }
  );
});
