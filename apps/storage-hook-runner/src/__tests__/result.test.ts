import { describe, expect, it } from 'vitest';
import { clampTimeout } from '../contract.ts';
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
    [`{"allow":false,"reason":"${'r'.repeat(201)}"}`],
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

  it('counts the reason in code points, not UTF-16 units', () => {
    const emoji200 = '\u{1F512}'.repeat(200); // 400 UTF-16 units
    expect(validateHookReturn(JSON.stringify({ allow: false, reason: emoji200 }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: emoji200,
    });
    expect(
      validateHookReturn(JSON.stringify({ allow: false, reason: `${emoji200}x` }))
    ).toMatchObject({ cause: 'invalid_result' });
  });

  it('measures the length after stripping control characters', () => {
    const reason = `${'r'.repeat(200)}\u0000\u0007`;
    expect(validateHookReturn(JSON.stringify({ allow: false, reason }))).toEqual({
      allow: false,
      cause: 'denied',
      reason: 'r'.repeat(200),
    });
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
    [now - 60, true],
    [now + 60, true],
    [now - 61, false],
    [now + 61, false],
    [now + 0.5, false],
    ['1800000000', false],
    [undefined, false],
    [null, false],
  ])('ts=%s ok=%s', (ts, ok) => {
    expect(checkTimestamp(ts, now).ok).toBe(ok);
  });
});
