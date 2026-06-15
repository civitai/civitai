import { describe, expect, it } from 'vitest';
import { APP_CHROME_NAME_MAX, sanitizeAppChromeName } from '../appChromeName';

describe('sanitizeAppChromeName', () => {
  it('passes a normal name through unchanged', () => {
    expect(sanitizeAppChromeName('Background Remover')).toBe('Background Remover');
  });

  it('returns null for empty / undefined / null', () => {
    expect(sanitizeAppChromeName(undefined)).toBeNull();
    expect(sanitizeAppChromeName(null)).toBeNull();
    expect(sanitizeAppChromeName('')).toBeNull();
  });

  it('returns null for whitespace-only (so the caller falls back to "App block")', () => {
    expect(sanitizeAppChromeName('   ')).toBeNull();
    expect(sanitizeAppChromeName('\t\n')).toBeNull();
  });

  it('trims and collapses internal whitespace / newlines to single spaces', () => {
    expect(sanitizeAppChromeName('  Cool   App  ')).toBe('Cool App');
    expect(sanitizeAppChromeName('Line1\nLine2')).toBe('Line1 Line2');
    expect(sanitizeAppChromeName('a\t\t b')).toBe('a b');
  });

  it('strips bidi / RTL-override control chars (display-reordering spoof vector)', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — used to visually reverse following text.
    expect(sanitizeAppChromeName('Safe‮App')).toBe('SafeApp');
    // A name made entirely of bidi controls collapses to nothing -> null -> fallback.
    expect(sanitizeAppChromeName('‭‮‬')).toBeNull();
  });

  it('strips zero-width and other format/control chars', () => {
    // zero-width space (200B), zero-width joiner (200D), soft hyphen (00AD)
    expect(sanitizeAppChromeName('Ev​il‍­App')).toBe('EvilApp');
    // raw control chars: tab (0009) collapses as whitespace, bell (0007) is removed.
    expect(sanitizeAppChromeName('Tab	Bell')).toBe('Tab Bell');
  });

  it('bounds the accessible name length (a screen reader reads the full string, not the clipped box)', () => {
    const long = 'A'.repeat(200);
    const out = sanitizeAppChromeName(long)!;
    expect(out.length).toBeLessThanOrEqual(APP_CHROME_NAME_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate a name exactly at the cap', () => {
    const exact = 'B'.repeat(APP_CHROME_NAME_MAX);
    expect(sanitizeAppChromeName(exact)).toBe(exact);
  });

  it('bounds length by code point and never leaves a lone surrogate at the cut', () => {
    // Emoji straddles the UTF-16 code-unit cut point — a naive `.slice(unit)` would
    // split the surrogate pair and leave a lone high surrogate (renders as �).
    const name = 'x'.repeat(APP_CHROME_NAME_MAX - 2) + '😀' + 'y'.repeat(5);
    const out = sanitizeAppChromeName(name)!;
    expect(out.endsWith('…')).toBe(true);
    // No lone surrogate: spreading by code point, a split pair would surface a
    // single unit in the surrogate range (U+D800–U+DFFF); a valid pair surfaces as
    // one >U+FFFF code point.
    const hasLoneSurrogate = [...out].some((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0xd800 && cp <= 0xdfff;
    });
    expect(hasLoneSurrogate).toBe(false);
  });

  it('caps stacked combining marks (Zalgo) so the label can’t overflow the bar', () => {
    // 70 combining acute accents on one base — the chrome-overflow spoof vector.
    // NFC composes the base + first mark into a precomposed letter (A + ́ → Á), then
    // the remaining run is capped: the result is a short, bounded string, not 70
    // stacked diacritics.
    const zalgo = 'A' + '́'.repeat(70);
    const out = sanitizeAppChromeName(zalgo)!;
    const markCount = [...out].filter((ch) => /\p{M}/u.test(ch)).length;
    expect(markCount).toBeLessThanOrEqual(2);
    // Bounded total length (vs the 71-codepoint input) — no overflow.
    expect([...out].length).toBeLessThanOrEqual(3);
  });

  it('preserves legitimate diacritics (does not over-strip a real accented name)', () => {
    // Vietnamese: NFC keeps these as precomposed letters, no marks dropped.
    expect(sanitizeAppChromeName('Tiếng Việt')).toBe('Tiếng Việt');
  });

  it('keeps legitimate unicode letters (non-format) intact', () => {
    expect(sanitizeAppChromeName('Café Studio')).toBe('Café Studio');
    expect(sanitizeAppChromeName('日本語アプリ')).toBe('日本語アプリ');
  });
});
