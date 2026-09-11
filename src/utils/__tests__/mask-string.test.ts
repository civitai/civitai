import { describe, expect, it } from 'vitest';
import { maskEmail, maskString } from '~/utils/string-helpers';

describe('maskString', () => {
  it('keeps the requested ends and hides the middle', () => {
    expect(maskString('abcdefghij', { start: 2, end: 3 })).toBe('ab•••••hij');
  });

  it('keeps only the front when no end is asked for', () => {
    expect(maskString('abcdefghij', { start: 2 })).toBe('ab•••••');
  });

  it('hides everything when neither end is kept', () => {
    expect(maskString('abcdefghij')).toBe('•••••');
  });

  /**
   * The reason the run is fixed rather than one character per hidden character. A per-character
   * mask passes every other assertion here while still telling a reader how long the secret is.
   */
  it('emits the same mask whatever the input length', () => {
    const short = maskString('aa@b.co', { start: 1, end: 5 });
    const long = maskString('aaaaaaaaaaaaaaaaaaaaaaaaa@b.co', { start: 1, end: 5 });

    expect(short).toBe(long);
    expect(long).not.toContain('aa');
  });

  it('returns the mask alone rather than the input when the kept ends cover it', () => {
    expect(maskString('abc', { start: 2, end: 2 })).toBe('•••••');
    expect(maskString('abc', { start: 3 })).toBe('•••••');
  });

  it('treats negative bounds as zero rather than slicing from the far end', () => {
    expect(maskString('abcdefghij', { start: -4, end: -4 })).toBe('•••••');
  });

  it('accepts a custom mask', () => {
    expect(maskString('abcdefghij', { start: 1, end: 1, mask: '***' })).toBe('a***j');
  });

  it('returns an empty string for empty input', () => {
    expect(maskString('')).toBe('');
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the whole domain', () => {
    expect(maskEmail('someone@example.com')).toBe('s•••••@example.com');
  });

  it('does not leak the length of the local part', () => {
    expect(maskEmail('ab@example.com')).toBe(maskEmail('aaaaaaaaaaaaaaaaaaaa@example.com'));
  });

  /**
   * Keeping the first character AND the domain of `a@example.com` would show the whole address
   * behind decoy dots. Masking outright is the honest result.
   */
  it('masks everything when the local part is too short to hide any of it', () => {
    expect(maskEmail('a@example.com')).toBe('•••••');
  });

  it('splits on the LAST @, so a local part containing one still masks', () => {
    expect(maskEmail('we"ir"d@e@example.com')).toBe('w•••••@example.com');
  });

  it('hides the whole value when there is no domain to keep', () => {
    expect(maskEmail('not-an-email')).toBe('•••••');
  });

  it('hides the whole value when the address starts with @', () => {
    expect(maskEmail('@example.com')).toBe('•••••');
  });
});
