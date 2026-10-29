import { describe, expect, it } from 'vitest';
import type { Recap } from '$lib/server/daily/daily.service';
import { recapLines } from './recap-text';

const recap = (over: Partial<Recap> = {}): Recap => ({
  day: '2026-12-14',
  when: 'yesterday',
  cast: 30,
  confirmed: 18,
  graded: 21,
  accuracy: 18 / 21,
  goldEarned: 1800,
  pending: 0,
  streakBonus: 0,
  ...over,
});

describe('recapLines', () => {
  it('reads like the recap the player sees', () => {
    expect(recapLines(recap())[0]).toBe(
      "18 of yesterday's 30 judgments were confirmed · accuracy 86% · +1,800 gold earned"
    );
  });

  it('names the date when the last play day was not yesterday', () => {
    expect(recapLines(recap({ when: 'on Oct 26' }))[0]).toBe(
      '18 of your 30 judgments on Oct 26 were confirmed · accuracy 86% · +1,800 gold earned'
    );
  });

  it('leaves accuracy out until something has settled, and says what is pending', () => {
    expect(
      recapLines(recap({ confirmed: 0, graded: 0, accuracy: null, goldEarned: 0, pending: 30 }))[0]
    ).toBe(
      "0 of yesterday's 30 judgments were confirmed · +0 gold earned · 30 still awaiting a verdict"
    );
  });

  it('agrees with a single judgment', () => {
    expect(
      recapLines(recap({ cast: 1, confirmed: 1, graded: 1, accuracy: 1, goldEarned: 100 }))[0]
    ).toBe("1 of yesterday's 1 judgment was confirmed · accuracy 100% · +100 gold earned");
  });

  it('puts the streak bonus on its own line, apart from vote gold', () => {
    const lines = recapLines(recap({ streakBonus: 700 }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('700');
    expect(lines[1]).toBe('+700 streak bonus');
  });

  it('has no bonus line when none was paid', () => {
    expect(recapLines(recap())).toHaveLength(1);
  });
});
