import { describe, expect, it } from 'vitest';
import { clampTimeout } from '../contract.ts';
import { SIG_SKEW_SECONDS } from '../limits.ts';
import { outcomeOf, validateHookReturn } from '../result.ts';
import { checkTimestamp } from '../signing.ts';

describe('validateHookReturn', () => {
  it.each([
    ['{"allow":true}', { allow: true }],
    ['{"allow":false,"reason":"no"}', { allow: false, cause: 'denied', reason: 'no' }],
    ['{"reason":"no","allow":false}', { allow: false, cause: 'denied', reason: 'no' }],
  ])('accepts %s', (json, expected) => {
    expect(validateHookReturn(json)).toEqual(expected);
  });

  it.each([
    ['{"allow":"yes"}'],
    ['{"allow":false}'],
    ['{"allow":true,"reason":"x"}'],
    ['{"allow":false,"reason":"x","extra":1}'],
    ['{"allow":false,"reason":"   "}'],
    ['{"allow":false,"reason":"\\u0000\\u0001"}'],
    ['{}'],
    ['[]'],
    ['true'],
    ['"allow"'],
    ['null'],
    ['not json'],
  ])('refuses %s as invalid_result', (json) => {
    expect(validateHookReturn(json)).toMatchObject({ allow: false, cause: 'invalid_result' });
  });

  it('refuses undefined (a hook returning undefined or a function)', () => {
    expect(validateHookReturn(undefined)).toMatchObject({ cause: 'invalid_result' });
  });

  // Over-long reasons are TRUNCATED to 200 code points (operator decision), not refused. The
  // kept and dropped parts use different characters so a cut from the wrong end, or at the
  // wrong length, shows.
  it('truncates a reason over 200 code points to its first 200', () => {
    const reason = `${'a'.repeat(200)}${'b'.repeat(50)}`;
    expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: 'a'.repeat(200),
    });
  });

  it('keeps a reason of exactly 200 code points whole', () => {
    const reason = `${'a'.repeat(199)}z`;
    expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
      allow: false,
      cause: 'denied',
      reason,
    });
  });

  it('counts code points, not UTF-16 units, when truncating', () => {
    const emoji200 = '\u{1F512}'.repeat(200); // 400 UTF-16 units
    expect(validateHookReturn(JSON.stringify({ allow: false, reason: emoji200 }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: emoji200,
    });
    expect(validateHookReturn(JSON.stringify({ allow: false, reason: `${emoji200}x` }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: emoji200,
    });
  });

  it('strips control characters BEFORE truncating', () => {
    // Truncating first would keep 195 a's; stripping first keeps 200.
    const reason = `${'\u0000'.repeat(5)}${'a'.repeat(200)}b`;
    expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: 'a'.repeat(200),
    });
  });

  it('strips U+061C, U+2028, U+2029 and U+FEFF', () => {
    expect(
      validateHookReturn(JSON.stringify({ allow: false, reason: 'a\u061Cb\u2028c\u2029d\uFEFFe' }))
    ).toEqual({ allow: false, cause: 'denied', reason: 'abcde' });
  });

  // The reason is clipped to 2 x 200 UTF-16 units BEFORE the strip regex and the code-point
  // split, so a huge reason costs O(400). Consequence, pinned: only those first 400 units count,
  // so controls filling them leave less text.
  it('considers only the first 400 UTF-16 units', () => {
    const reason = `${'\u0000'.repeat(300)}${'b'.repeat(300)}`;
    expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: 'b'.repeat(100),
    });
  });

  it('does not leave half a surrogate pair at the 400-unit cut', () => {
    const lock = '\u{1F512}';
    const reason = `a${lock.repeat(250)}`; // unit 400 is the high half of the 200th lock
    const out = validateHookReturn(JSON.stringify({ allow: false, reason }));
    expect(out).toEqual({ allow: false, cause: 'denied', reason: `a${lock.repeat(199)}` });
  });

  it('a reason that is blank after stripping is invalid_result "deny reason is empty"', () => {
    for (const reason of ['', '   ', '\u0000\u0007', '\u202e \n']) {
      expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
        allow: false,
        cause: 'invalid_result',
        detail: 'deny reason is empty',
      });
    }
  });
});

describe('outcomeOf', () => {
  it('maps each result to its metric outcome', () => {
    expect(outcomeOf({ allow: true })).toBe('allow');
    expect(outcomeOf({ allow: false, cause: 'denied', reason: 'r' })).toBe('deny');
    expect(outcomeOf({ allow: false, cause: 'oom', detail: 'd' })).toBe('oom');
  });
});

describe('clampTimeout', () => {
  it.each([
    [undefined, 50],
    [0, 1],
    [-5, 1],
    [1, 1],
    [37.4, 37],
    [500, 500],
    [501, 500],
    [1e9, 500],
  ])('%s -> %i', (input, expected) => {
    expect(clampTimeout(input)).toBe(expected);
  });
});

describe('checkTimestamp', () => {
  const now = 1_800_000_000;
  it.each([
    [now, true],
    [now - SIG_SKEW_SECONDS, true],
    [now + SIG_SKEW_SECONDS, true],
    [now - SIG_SKEW_SECONDS - 1, false],
    [now + SIG_SKEW_SECONDS + 1, false],
    [now + 0.5, false],
    ['1800000000', false],
    [undefined, false],
    [null, false],
  ])('ts=%s ok=%s', (ts, ok) => {
    expect(checkTimestamp(ts, now).ok).toBe(ok);
  });
});
