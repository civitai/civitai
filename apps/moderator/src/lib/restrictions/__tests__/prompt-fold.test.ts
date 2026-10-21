import { describe, expect, it } from 'vitest';
import {
  cutSegments,
  foldPrompt,
  keepThroughFor,
  lastMatchEnd,
  lastSegmentEnd,
} from '../prompt-fold';

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

describe('foldPrompt without locatable evidence', () => {
  it('never folds when told the evidence cannot be located', () => {
    const text = 'word, '.repeat(1000);
    expect(foldPrompt(text, { ...OPTS, keepThrough: null })).toEqual({
      folded: false,
      head: text,
      total: text.length,
    });
  });
});

describe('keepThroughFor', () => {
  const text = 'a cat, '.repeat(10) + 'a dog';

  it('reports where the last literal match ends in the box it belongs to', () => {
    expect(keepThroughFor(text, 'prompt', [{ text: 'dog', field: 'prompt' }])).toBe(text.length);
  });

  it('says nothing is to be kept when the trigger recorded no literal or regex evidence', () => {
    expect(keepThroughFor(text, 'prompt', [])).toBe(0);
    expect(keepThroughFor(text, 'prompt', [{}])).toBe(0);
  });

  it('refuses to fold a box a regex-only match applies to', () => {
    expect(keepThroughFor(text, 'prompt', [{ regex: 'd.g' }])).toBeNull();
    expect(keepThroughFor(text, 'prompt', [{ regex: 'd.g', field: 'prompt' }])).toBeNull();
    expect(keepThroughFor(text, 'text', [{ regex: 'd.g', field: 'negativePrompt' }])).toBeNull();
  });

  it('refuses to fold when a regex match also carries a gate word', () => {
    expect(keepThroughFor(text, 'prompt', [{ regex: 'd.g', gateWord: 'cat' }])).toBeNull();
  });

  it('ignores evidence that belongs to the other box', () => {
    expect(keepThroughFor(text, 'prompt', [{ regex: 'd.g', field: 'negativePrompt' }])).toBe(0);
  });

  it('refuses to fold when a literal named for this box is not in it', () => {
    expect(keepThroughFor(text, 'prompt', [{ text: 'zebra', field: 'prompt' }])).toBeNull();
  });

  it('refuses to fold when no applicable literal is found anywhere in the box', () => {
    expect(keepThroughFor(text, 'prompt', [{ text: 'zebra' }])).toBeNull();
  });

  it('keeps through a field-less literal that is found, even if another is elsewhere', () => {
    expect(keepThroughFor(text, 'prompt', [{ text: 'cat' }, { text: 'zebra' }])).toBe(
      text.lastIndexOf('cat') + 3
    );
  });

  it('counts a gate word for the prompt and scanned text but not the negative', () => {
    expect(keepThroughFor(text, 'prompt', [{ gateWord: 'dog' }])).toBe(text.length);
    expect(keepThroughFor(text, 'text', [{ gateWord: 'dog' }])).toBe(text.length);
    expect(keepThroughFor(text, 'negativePrompt', [{ gateWord: 'zebra' }])).toBe(0);
  });
});

describe('lastMatchEnd', () => {
  it('finds where the last highlighted needle ends, case-insensitively', () => {
    expect(lastMatchEnd('a Cat, a dog, a cat', ['cat', 'dog'])).toBe(19);
  });

  it('reports positions in the original text when lowercasing would change its length', () => {
    // 'İ' lowercases to two code units, which would shift every later index.
    const text = 'İİİİ a cat';
    expect(lastMatchEnd(text, ['cat'])).toBe(text.length);
    expect(keepThroughFor(text, 'prompt', [{ text: 'CAT' }])).toBe(text.length);
  });

  it('finds the last occurrence even when occurrences overlap', () => {
    expect(lastMatchEnd('aaa', ['aa'])).toBe(3);
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
