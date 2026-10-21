import { describe, expect, it } from 'vitest';
import { cutSegments, foldPrompt, lastMatchEnd, lastSegmentEnd } from '../prompt-fold';

const OPTS = { threshold: 2500, head: 1100 };

describe('foldPrompt', () => {
  it('leaves a prompt at or under the threshold whole', () => {
    const text = 'a'.repeat(2500);
    expect(foldPrompt(text, OPTS)).toEqual({ folded: false, head: text, total: 2500 });
  });

  it('folds a longer prompt to about the head length', () => {
    const text = 'word '.repeat(700);
    const r = foldPrompt(text, OPTS);
    expect(r.folded).toBe(true);
    expect(r.total).toBe(text.length);
    expect(r.head.length).toBeLessThanOrEqual(1100);
    expect(r.head.length).toBeGreaterThan(900);
  });

  it('cuts at a comma rather than mid-tag', () => {
    const text = 'masterpiece, '.repeat(300);
    const r = foldPrompt(text, OPTS);
    expect(r.folded).toBe(true);
    expect(r.head.endsWith('masterpiece')).toBe(true);
  });

  it('falls back to a hard cut when there is no boundary to use', () => {
    const r = foldPrompt('a'.repeat(3000), OPTS);
    expect(r.head).toHaveLength(1100);
  });

  it('keeps a late match visible and still folds the rest', () => {
    const text = 'word, '.repeat(1000);
    const r = foldPrompt(text, { ...OPTS, keepThrough: 3000 });
    expect(r.folded).toBe(true);
    expect(r.head.length).toBeGreaterThanOrEqual(3000);
    expect(r.head.length).toBeLessThan(text.length);
  });

  it('shows the whole prompt when keeping the match leaves only a short tail', () => {
    const text = 'word, '.repeat(1000);
    const r = foldPrompt(text, { ...OPTS, keepThrough: 5800 });
    expect(r).toEqual({ folded: false, head: text, total: text.length });
  });
});

describe('lastMatchEnd', () => {
  it('finds where the last highlighted needle ends, case-insensitively', () => {
    expect(lastMatchEnd('a Cat, a dog, a cat', ['cat', 'dog'])).toBe(19);
  });

  it('ignores blank needles and reports 0 without a match', () => {
    expect(lastMatchEnd('nothing here', [' ', 'zebra'])).toBe(0);
  });
});

describe('lastSegmentEnd', () => {
  it('reports where the last categorised segment ends', () => {
    const segs = [
      { text: 'ab', category: 'x' },
      { text: 'cde', category: null },
      { text: 'fg', category: 'y' },
      { text: 'hi', category: null },
    ];
    expect(lastSegmentEnd(segs)).toBe(7);
  });
});

describe('cutSegments', () => {
  const segs = [
    { text: 'abc', category: null },
    { text: 'defg', category: 'x' },
    { text: 'hij', category: null },
  ];

  it('keeps whole segments up to the length and trims the one it lands in', () => {
    expect(cutSegments(segs, 5)).toEqual([
      { text: 'abc', category: null },
      { text: 'de', category: 'x' },
    ]);
  });

  it('returns every segment when the length covers them', () => {
    expect(cutSegments(segs, 99)).toEqual(segs);
  });
});
