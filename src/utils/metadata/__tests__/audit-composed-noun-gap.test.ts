import { describe, it, expect } from 'vitest';
import { auditPrompt, includesMinor } from '~/utils/metadata/audit';

/**
 * Semantics of `composedNounGap` — the bounded gap that lets `young` … `girl` flag when
 * `girl` alone does not.
 *
 * Nothing else pins its width or its paragraph rule: audit-matching-equivalence.test.ts
 * imports the composed terms as vocabulary, so it passes whatever the gap says, and
 * audit-redos.test.ts only asks that the bound is finite. These are the tests a gap
 * change has to argue with.
 */
// `girl`/`boy` are reachable ONLY via this composed path, so the width is a recall
// decision on the minor-detection path (#2727 M1 widened it 40→200).
describe('composed young-noun recall boundary ({0,200} gap)', () => {
  it('flags a spaced "young … girl" phrasing within the 200-char window (~150 chars)', () => {
    const input = 'young ' + 'word '.repeat(30) + 'girl';
    expect(input.length).toBeLessThan(200);
    expect(input.length).toBeGreaterThan(40); // would have been MISSED at the old {0,40} bound
    expect(includesMinor(input)).toBeTruthy();
  });

  it('does NOT match when the gap is clearly over the 200-char bound', () => {
    const input = 'young ' + 'word '.repeat(60) + 'girl';
    expect(input.length).toBeGreaterThan(200 + 'young girl'.length);
    expect(includesMinor(input)).toBeFalsy();
  });
});

describe('composed young-noun gap across paragraphs', () => {
  it('does not join an adjective to a noun in a later paragraph', () => {
    expect(auditPrompt('skinny, small butt\n\n\n\n1boy, nude').success).toBe(true);
    expect(includesMinor('small cute\n\nboy')).toBeFalsy();
    expect(includesMinor('small cute\r\n\r\nboy')).toBeFalsy();
    expect(includesMinor('small cute\n  \t\nboy')).toBeFalsy();
  });

  it('still joins across a single line break, or a gap of only whitespace/punctuation', () => {
    expect(includesMinor('small brown\nboy')).toBeTruthy();
    expect(includesMinor('small brown\r\nboy')).toBeTruthy();
    expect(includesMinor('small\n\nboy')).toBeTruthy();
    expect(includesMinor('small brown boy')).toBeTruthy();
    expect(includesMinor('young\tpretty girl')).toBeTruthy();
    expect(includesMinor('young pretty girl')).toBeTruthy();
  });

  it('keeps the minor + nsfw combination whole-prompt: a paragraph break never separates them', () => {
    for (const prompt of [
      'schoolgirl\n\nnude',
      'young girl\n\n\n\nmasterpiece, detailed\n\nnude',
      'nude\n\nsmall brown boy',
    ]) {
      const result = auditPrompt(prompt);
      expect(result.success, prompt).toBe(false);
      expect(result.blockedFor, prompt).toContain('Inappropriate minor content');
    }
  });
});
