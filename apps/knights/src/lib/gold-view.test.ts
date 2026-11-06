import { describe, expect, it } from 'vitest';
import { goldView } from './gold-view';

describe('goldView', () => {
  it('shows spendable plus pending on the pill, and splits them in the popover', () => {
    expect(goldView({ goldSpendable: 3200, goldPending: 900 }, 1000)).toMatchObject({
      pill: 4100,
      spendable: '3,200',
      pending: '900',
    });
  });

  it('values only spendable gold in Buzz, rounded down to whole Buzz at the configured rate', () => {
    expect(goldView({ goldSpendable: 3200, goldPending: 900 }, 1000).buzz).toBe('3 Buzz');
    expect(goldView({ goldSpendable: 999, goldPending: 0 }, 1000).buzz).toBe('0 Buzz');
    expect(goldView({ goldSpendable: 5000, goldPending: 0 }, 500).buzz).toBe('10 Buzz');
  });

  it('drops the pill and the Buzz value once the shop has taken gold', () => {
    const before = goldView({ goldSpendable: 60_200, goldPending: 3_100 }, 20);
    const after = goldView({ goldSpendable: 200, goldPending: 3_100 }, 20);
    expect([before.pill, before.buzz]).toEqual([63_300, '3,010 Buzz']);
    expect([after.pill, after.buzz]).toEqual([3_300, '10 Buzz']);
  });

  it('prints the rate from the config it was given', () => {
    expect(goldView({ goldSpendable: 0, goldPending: 0 }, 1000).rate).toBe('1,000 gold = 1 Buzz');
    expect(goldView({ goldSpendable: 0, goldPending: 0 }, 250).rate).toBe('250 gold = 1 Buzz');
  });
});
