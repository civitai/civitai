import { describe, it, expect } from 'vitest';
import { includesMinor } from '~/utils/metadata/audit';

/**
 * Semantics of `composedNounGap` — the bounded gap that lets `young` … `girl` flag when
 * `girl` alone does not.
 *
 * Nothing else pins its width: audit-matching-equivalence.test.ts imports the composed
 * terms as vocabulary, so it passes whatever the gap says, and audit-redos.test.ts only
 * asks that the bound is finite. This is the test a width change has to argue with.
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
