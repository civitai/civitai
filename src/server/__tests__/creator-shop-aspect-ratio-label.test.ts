import { describe, expect, it } from 'vitest';
import { aspectRatioLabel } from '~/server/schema/creator-shop.schema';

describe('aspectRatioLabel', () => {
  it.each([
    // The profile-background recommendation, which a stale comment had mislabeled "25:9".
    [450, 144, '25:8'],
    [144, 144, '1:1'],
    [256, 256, '1:1'],
    [1920, 1080, '16:9'],
    [120, 90, '4:3'],
  ])('reduces %i×%i to "%s"', (width, height, expected) => {
    expect(aspectRatioLabel(width, height)).toBe(expected);
  });

  // The guarantee this case exists for is arithmetic safety — never a division by zero, so never a
  // `NaN:NaN` or `Infinity:0` label reaching a shop page. It is NOT "the dimensions are echoed back
  // unreduced": `gcd(450, 0)` is 450 (`b === 0 ? a`), so 450×0 genuinely reduces to "1:0", and the
  // `|| 1` fallback in `aspectRatioLabel` is reached only by 0×0, where `gcd` returns 0.
  //
  // This assertion previously read `'450:0'`, which the implementation has never produced. It was
  // added alongside a comment fix in #4949 and merged while this shard was already red, so it has
  // never once passed. Corrected here to the value the function actually guarantees — and paired
  // with the property check below, so the case tests the safety claim in its own name rather than
  // pinning whatever the code happens to return.
  it('does not divide by zero when a dimension is 0', () => {
    expect(aspectRatioLabel(0, 0)).toBe('0:0');
    expect(aspectRatioLabel(450, 0)).toBe('1:0');
    expect(aspectRatioLabel(0, 144)).toBe('0:1');
  });

  it.each([
    [0, 0],
    [450, 0],
    [0, 144],
  ])('never yields NaN or Infinity for %i×%i', (width, height) => {
    const label = aspectRatioLabel(width, height);
    expect(label).not.toMatch(/NaN|Infinity/);
    // Both sides must be finite numbers — a label is only useful if it renders as one.
    for (const part of label.split(':')) expect(Number.isFinite(Number(part))).toBe(true);
  });
});
