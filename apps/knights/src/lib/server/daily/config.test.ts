import { describe, expect, it } from 'vitest';
import { DAILY_GOLD_CAP_BY_LEVEL, dailyGoldCapFor, dailyGoldCapOf, goldWithinCap } from './config';

describe('dailyGoldCapOf', () => {
  it('is 0 below level 20, where no vote earns gold', () => {
    expect(dailyGoldCapOf(1)).toBe(0);
    expect(dailyGoldCapOf(19)).toBe(0);
  });

  it('uses the row for the highest level at or below the player', () => {
    expect(dailyGoldCapOf(20)).toBe(80_000);
    expect(dailyGoldCapOf(29)).toBe(80_000);
    expect(dailyGoldCapOf(47)).toBe(120_000);
    expect(dailyGoldCapOf(90)).toBe(200_000);
    expect(dailyGoldCapOf(130)).toBe(400_000);
    expect(dailyGoldCapOf(200)).toBe(400_000);
  });

  it('rises with level', () => {
    const golds = DAILY_GOLD_CAP_BY_LEVEL.map((row) => row.gold);
    expect(golds).toEqual([...golds].sort((a, b) => a - b));
  });
});

describe('dailyGoldCapFor', () => {
  it('follows level, not rank', () => {
    expect(dailyGoldCapFor('Knight', 47)).toBe(120_000);
    expect(dailyGoldCapFor('Knight', 60)).toBe(160_000);
    expect(dailyGoldCapFor('Paladin', 130)).toBe(400_000);
  });

  it("never drops below the rank's first level, so a Knight whose XP fell under 20 keeps the Knight cap", () => {
    expect(dailyGoldCapFor('Knight', 3)).toBe(80_000);
    expect(dailyGoldCapFor('Templar', 40)).toBe(140_000);
  });

  it('is 0 for a rank that earns no gold, whatever its level, and for an unknown rank', () => {
    expect(dailyGoldCapFor('Acolyte', 19)).toBe(0);
    expect(dailyGoldCapFor('Inquisitor', 120)).toBe(0);
    expect(dailyGoldCapFor('Squire', 50)).toBe(0);
  });
});

describe('goldWithinCap', () => {
  it('keeps what fits, trims the vote that crosses, and gives nothing past the cap', () => {
    expect(goldWithinCap(1000, 0, 100)).toBe(100);
    expect(goldWithinCap(1000, 940, 100)).toBe(60);
    expect(goldWithinCap(1000, 1000, 100)).toBe(0);
    expect(goldWithinCap(1000, 1010, 100)).toBe(0);
  });

  it('records nothing under a cap of 0', () => {
    expect(goldWithinCap(0, 0, 100)).toBe(0);
  });
});
