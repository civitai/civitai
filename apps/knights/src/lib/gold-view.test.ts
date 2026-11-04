import { describe, expect, it } from 'vitest';
import { goldView } from './gold-view';

describe('goldView', () => {
  it('shows earned plus pending on the pill, and splits them in the popover', () => {
    expect(goldView({ goldEarned: 3200, goldPending: 900 }, 1000)).toMatchObject({
      pill: 4100,
      earned: '3,200',
      pending: '900',
    });
  });

  it('values only earned gold in Buzz, rounded down to whole Buzz at the configured rate', () => {
    expect(goldView({ goldEarned: 3200, goldPending: 900 }, 1000).buzz).toBe('3 Buzz');
    expect(goldView({ goldEarned: 999, goldPending: 0 }, 1000).buzz).toBe('0 Buzz');
    expect(goldView({ goldEarned: 5000, goldPending: 0 }, 500).buzz).toBe('10 Buzz');
  });

  it('prints the rate from the config it was given', () => {
    expect(goldView({ goldEarned: 0, goldPending: 0 }, 1000).rate).toBe('1,000 gold = 1 Buzz');
    expect(goldView({ goldEarned: 0, goldPending: 0 }, 250).rate).toBe('250 gold = 1 Buzz');
  });
});
