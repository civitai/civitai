import { describe, expect, it } from 'vitest';
import { RANK_RULES } from '../ranks';
import { dailyGoldCapOf, goldWithinCap } from './config';

describe('dailyGoldCapOf', () => {
  it('is the rank rule for a known rank', () => {
    expect(dailyGoldCapOf('Templar')).toBe(RANK_RULES.Templar.dailyGoldCap);
  });

  it('is 0 for a rank it does not know, rather than throwing', () => {
    expect(dailyGoldCapOf('Squire')).toBe(0);
    expect(dailyGoldCapOf('')).toBe(0);
  });
});

describe('goldWithinCap', () => {
  it('keeps what fits, trims the vote that crosses, and gives nothing past the cap', () => {
    const cap = dailyGoldCapOf('Knight');
    expect(goldWithinCap('Knight', 0, 100)).toBe(100);
    expect(goldWithinCap('Knight', cap - 60, 100)).toBe(60);
    expect(goldWithinCap('Knight', cap, 100)).toBe(0);
    expect(goldWithinCap('Knight', cap + 10, 100)).toBe(0);
  });

  it('records no gold for an unknown rank', () => {
    expect(goldWithinCap('Squire', 0, 100)).toBe(0);
  });
});
