import { describe, it, expect } from 'vitest';
import { auditPromptEnriched, includesMinor } from '~/utils/metadata/audit';

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

describe('composed young-noun must start a word', () => {
  it.each([
    'pale charcoal underside, small curved crimson horns',
    'holding wrapped candy, tiny curved crimson',
    'small seasonal decorations',
    'little poison bottle',
    'young person',
    'kawaii, young, cowboy shot, high angle',
    'young cowboy',
    'young cowboys riding horses',
    'bare midriff, tiny boyshorts',
    'tiny boy-shorts',
    'small boy_shorts',
  ])('does not flag %j', (input) => {
    expect(includesMinor(input)).toBeFalsy();
  });

  it.each([
    'young girl',
    'young girls',
    'littlegirl',
    'young catgirl',
    'little schoolgirl',
    'young boy',
    'small femboy',
    'young tomboy',
    'young son',
    'young stepson',
    'small granddaughter',
    'little half sister',
    'little halfsister',
    'young godbrother',
    'young,  boy',
    'tiny curved son',
    'tiny boy shorts',
    'young boy, shorts',
    'young schoolboy',
  ])('still flags %j', (input) => {
    expect(includesMinor(input)).toBeTruthy();
  });

  // The prompts behind the reported false blocks, trimmed to the matched tag and the NSFW
  // word that lets the minor sub-check run.
  it.each([
    'completely naked, nude, holding wrapped candy, tiny curved crimson horns',
    '1girl, anthro, kobold, pale charcoal underside, small curved crimson horns, sexy',
    'small breasts, cute, kawaii, young, cowboy shot, high angle, panty peek',
    'cleavage reveal, bare midriff, tiny boyshorts, bare legs',
    'naked, leather harness straps, canteen, weathered backpack',
  ])('does not hard-block %j as a minor', (prompt) => {
    const result = auditPromptEnriched(prompt);
    expect(result.triggers.map((t) => t.category)).not.toContain('inappropriate_minor');
  });

  it('still hard-blocks a young noun in an NSFW prompt', () => {
    const result = auditPromptEnriched('nude, young stepson');
    expect(result.success).toBe(false);
    expect(result.triggers[0]?.category).toBe('inappropriate_minor');
  });
});
