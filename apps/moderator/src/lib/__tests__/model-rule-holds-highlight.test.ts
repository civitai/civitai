import { describe, expect, it } from 'vitest';
import { fieldSegments, spansForField } from '../model-rule-holds-highlight';

const show = (text: string, spans: { start: number; end: number }[]) =>
  fieldSegments(text, spans).map((s) => (s.hit ? `[${s.text}]` : s.text));

describe('fieldSegments', () => {
  it('slices by the stored offsets, not by searching for the term', () => {
    // "cat" occurs twice; only the second occurrence is the match.
    expect(show('cat and cat', [{ start: 8, end: 11 }])).toEqual(['cat and ', '[cat]']);
  });

  it('returns one plain segment when nothing matched', () => {
    expect(show('plain', [])).toEqual(['plain']);
  });

  it('merges overlapping and adjacent spans into one highlight', () => {
    expect(
      show('abcdefgh', [
        { start: 1, end: 4 },
        { start: 3, end: 6 },
      ])
    ).toEqual(['a', '[bcdef]', 'gh']);
    expect(
      show('abcdefgh', [
        { start: 1, end: 3 },
        { start: 3, end: 5 },
      ])
    ).toEqual(['a', '[bcde]', 'fgh']);
  });

  it('handles spans given out of order and a span inside another', () => {
    expect(
      show('abcdefgh', [
        { start: 5, end: 7 },
        { start: 0, end: 8 },
        { start: 2, end: 3 },
      ])
    ).toEqual(['[abcdefgh]']);
  });

  it('renders a whole-field fallback span as one highlight', () => {
    const text = 'trained word';
    const segments = fieldSegments(text, [{ start: 0, end: text.length }]);
    expect(segments).toEqual([{ text, hit: true }]);
  });

  it('clamps spans past the end and ignores empty or inverted ones', () => {
    expect(show('abc', [{ start: 1, end: 99 }])).toEqual(['a', '[bc]']);
    expect(
      show('abc', [
        { start: 2, end: 2 },
        { start: 3, end: 1 },
        { start: -4, end: -1 },
      ])
    ).toEqual(['abc']);
  });

  it('never splits a surrogate pair at a span edge', () => {
    // "a😀b": the emoji is two UTF-16 units at 1..3.
    expect(show('a😀b', [{ start: 2, end: 3 }])).toEqual(['a', '[😀]', 'b']);
    expect(show('a😀b', [{ start: 1, end: 2 }])).toEqual(['a', '[😀]', 'b']);
  });

  it('keeps the text intact end to end', () => {
    const text = 'x 日本語 y';
    const joined = fieldSegments(text, [{ start: 2, end: 5 }])
      .map((s) => s.text)
      .join('');
    expect(joined).toBe(text);
  });
});

describe('spansForField', () => {
  const matches = [
    { ruleId: 1, term: 'a', field: 'Name', fieldIndex: 0, start: 0, end: 1 },
    { ruleId: 2, term: 'b', field: 'Words', fieldIndex: 1, start: 4, end: 6 },
  ];
  it('picks the matches of one field by index', () => {
    expect(spansForField(matches, 1)).toEqual([{ start: 4, end: 6 }]);
    expect(spansForField(matches, 2)).toEqual([]);
  });
});
