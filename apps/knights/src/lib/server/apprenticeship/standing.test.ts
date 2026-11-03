import { describe, expect, it } from 'vitest';
import {
  accuracyOf,
  chooseSource,
  earnsKnighthood,
  isCheckpoint,
  milestoneCopy,
  needsCoaching,
} from './standing';

describe('earnsKnighthood', () => {
  it('needs the level and a full window at the bar, and both together', () => {
    expect(earnsKnighthood({ level: 20, correct: 75, graded: 100 })).toBe(true);
    expect(earnsKnighthood({ level: 20, correct: 74, graded: 100 })).toBe(false);
    expect(earnsKnighthood({ level: 19, correct: 100, graded: 100 })).toBe(false);
  });

  it('does not count a window that is not yet full', () => {
    expect(earnsKnighthood({ level: 25, correct: 40, graded: 40 })).toBe(false);
  });
});

describe('accuracyOf', () => {
  it('is null before the first answer and a fraction after', () => {
    expect(accuracyOf({ correct: 0, graded: 0 })).toBeNull();
    expect(accuracyOf({ correct: 3, graded: 4 })).toBe(0.75);
  });
});

describe('isCheckpoint', () => {
  it('falls on every 20th answer and never on zero', () => {
    expect([0, 1, 19, 20, 21, 40].map(isCheckpoint)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
    ]);
  });
});

describe('needsCoaching', () => {
  it('offers help only below 60% and after at least 50 answers', () => {
    expect(needsCoaching(50, 0.59)).toBe(true);
    expect(needsCoaching(49, 0.1)).toBe(false);
    expect(needsCoaching(80, 0.6)).toBe(false);
    expect(needsCoaching(80, null)).toBe(false);
  });
});

describe('chooseSource', () => {
  const all = { core: true, rating: true, yesNo: true };

  it('serves the curated core first, whatever else is available', () => {
    expect(chooseSource({ position: 7, ...all })).toBe('core');
  });

  it('mixes yes/no into the rest on a fixed rhythm', () => {
    const kinds = Array.from({ length: 6 }, (_, position) =>
      chooseSource({ position, core: false, rating: true, yesNo: true })
    );
    expect(kinds).toEqual(['rating', 'rating', 'yesno', 'rating', 'rating', 'yesno']);
  });

  it('falls back to whichever kind still has items', () => {
    expect(chooseSource({ position: 2, core: false, rating: true, yesNo: false })).toBe('rating');
    expect(chooseSource({ position: 0, core: false, rating: false, yesNo: true })).toBe('yesno');
  });

  it('is null when nothing is left', () => {
    expect(chooseSource({ position: 0, core: false, rating: false, yesNo: false })).toBeNull();
  });
});

describe('milestoneCopy', () => {
  it('has words for levels 5, 10 and 15 only', () => {
    expect(milestoneCopy(10)).toMatch(/Level 10/);
    expect(milestoneCopy(10)).toMatch(/halfway/);
    expect([1, 4, 6, 20].map(milestoneCopy)).toEqual([null, null, null, null]);
  });
});
