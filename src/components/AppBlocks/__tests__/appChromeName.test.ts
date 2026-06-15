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

  it('keeps legitimate unicode letters (non-format) intact', () => {
    expect(sanitizeAppChromeName('Café Studio')).toBe('Café Studio');
    expect(sanitizeAppChromeName('日本語アプリ')).toBe('日本語アプリ');
  });
});
