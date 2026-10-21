import { describe, expect, it } from 'vitest';
import { cutSegments, foldPrompt } from '../prompt-fold';

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
