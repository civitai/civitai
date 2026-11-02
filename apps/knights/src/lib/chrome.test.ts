import { describe, expect, it } from 'vitest';
import { heartsLeft, rankPill, watchStrip } from './chrome';

const daily = { votes: 5, watchSize: 10, watchDone: false, bonusGold: 500, capReached: false };

describe('rankPill', () => {
  it('names the rank and level', () => {
    expect(rankPill({ rank: 'Knight', level: 12 })).toBe('Knight · Lv 12');
  });
});

describe('heartsLeft', () => {
  it('is what the smites leave, never below zero', () => {
    expect(heartsLeft({ smites: 1, maxSmites: 3 })).toBe(2);
    expect(heartsLeft({ smites: 5, maxSmites: 3 })).toBe(0);
  });
});

describe('watchStrip', () => {
  it('shows progress and the bonus still to earn', () => {
    expect(watchStrip(daily)).toEqual({
      label: "Today's Watch · 5 of 10",
      value: 5,
      max: 10,
      note: '+500 gold at the end',
    });
  });

  it('never counts past the Watch size', () => {
    expect(watchStrip({ ...daily, votes: 14 })).toMatchObject({ label: "Today's Watch · 10 of 10", value: 10 });
  });

  it('says so once the Watch is done', () => {
    expect(watchStrip({ ...daily, votes: 10, watchDone: true }).note).toBe('Complete · +500 gold earned');
  });

  it('says the gold cap is reached, and that XP still counts', () => {
    expect(watchStrip({ ...daily, capReached: true }).note).toBe('Gold cap reached · XP still counts');
  });

  it('formats a large bonus with separators', () => {
    expect(watchStrip({ ...daily, bonusGold: 1500 }).note).toBe('+1,500 gold at the end');
  });
});
