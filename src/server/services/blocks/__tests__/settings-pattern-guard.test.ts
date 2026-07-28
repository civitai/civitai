import { describe, expect, it } from 'vitest';
import {
  collectSettingsPatternErrors,
  isPatternRedosVulnerable,
} from '../settings-pattern-guard';

/**
 * Submission-time ReDoS gate coverage. This is the REAL manifest-submission
 * check (reached from BlockManifestValidator.validateSubmission) — the accurate
 * `recheck` analysis replaces the coarse `safe-regex` star-height heuristic that
 * false-positived on common linear patterns.
 */

// Patterns that MUST be accepted — common, linear/polynomial-but-safe developer
// patterns that `safe-regex` (the removed heuristic) wrongly rejected.
const SAFE_PATTERNS: Array<[string, string]> = [
  ['^[a-z0-9]+(-[a-z0-9]+)*$', 'canonical slug'],
  ['^\\d{1,4}(\\.\\d{1,2})?$', 'decimal'],
  ['^[a-z0-9]+(_[a-z0-9]+)*$', 'snake_case'],
  ['^[a-z !]+$', 'simple char class'],
  ['^#[0-9a-fA-F]{6}$', 'hex color'],
];

// Patterns that MUST be rejected — genuinely catastrophic backtracking.
// NOTE: `(.*)*` is intentionally NOT here — recheck (correctly) classifies a
// bare `(.*)*` as linear/safe: the greedy `.*` matches everything on the first
// pass, so there is no failing suffix to force exponential backtracking. That
// accuracy is the whole point of using recheck over safe-regex.
const VULNERABLE_PATTERNS: Array<[string, string]> = [
  ['(a+)+$', 'nested unbounded quantifier'],
  ['(x+x+)+y', 'adjacent unbounded quantifiers under a quantified group'],
  ['([a-zA-Z]+)*$', 'nested quantifier over a char class'],
];

describe('isPatternRedosVulnerable — accurate classification (recheck)', () => {
  it.each(SAFE_PATTERNS)('classifies %s (%s) as SAFE', async (pattern) => {
    // sanity: these compile
    expect(() => new RegExp(pattern)).not.toThrow();
    expect(await isPatternRedosVulnerable(pattern)).toBe(false);
  });

  it.each(VULNERABLE_PATTERNS)('classifies %s (%s) as VULNERABLE', async (pattern) => {
    // sanity: they DO compile — "is it a valid RegExp" alone would pass them
    expect(() => new RegExp(pattern)).not.toThrow();
    expect(await isPatternRedosVulnerable(pattern)).toBe(true);
  });
});

const stringField = (extra: Record<string, unknown>) => ({
  scope: 'publisher',
  type: 'string',
  widget: 'text',
  label: 'L',
  description: 'D',
  ...extra,
});

describe('collectSettingsPatternErrors — submission gate', () => {
  it('returns no errors for absent / non-object settings', async () => {
    expect(await collectSettingsPatternErrors(undefined)).toEqual([]);
    expect(await collectSettingsPatternErrors(null)).toEqual([]);
    expect(await collectSettingsPatternErrors('nope')).toEqual([]);
    expect(await collectSettingsPatternErrors([])).toEqual([]);
  });

  it('accepts a safe patterned field with a bounded max_length', async () => {
    const errors = await collectSettingsPatternErrors({
      slug: stringField({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', max_length: 64 }),
    });
    expect(errors).toEqual([]);
  });

  it('rejects a ReDoS-vulnerable pattern with a dev-facing error', async () => {
    const errors = await collectSettingsPatternErrors({
      evil: stringField({ pattern: '(a+)+$', max_length: 64 }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/settings\.evil/);
    expect(errors[0]).toMatch(/ReDoS/i);
  });

  it('rejects a patterned field that omits max_length', async () => {
    const errors = await collectSettingsPatternErrors({
      code: stringField({ pattern: '^[a-z]+$' }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/settings\.code/);
    expect(errors[0]).toMatch(/must also declare "max_length"/);
  });

  it('rejects a patterned field whose max_length exceeds the hard ceiling', async () => {
    const errors = await collectSettingsPatternErrors({
      code: stringField({ pattern: '^[a-z]+$', max_length: 5000 }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/max_length must be <= 1000/);
  });

  it('rejects a non-compiling pattern', async () => {
    const errors = await collectSettingsPatternErrors({
      code: stringField({ pattern: '(unclosed', max_length: 64 }),
    });
    expect(errors.some((e) => /not a valid RegExp source/.test(e))).toBe(true);
  });

  it('ignores non-string-pattern fields (numbers, booleans, no pattern)', async () => {
    const errors = await collectSettingsPatternErrors({
      count: { scope: 'publisher', type: 'number', label: 'L', description: 'D', min: 1, max: 10 },
      toggle: { scope: 'publisher', type: 'boolean', label: 'L', description: 'D' },
      plain_string: stringField({ max_length: 20 }),
    });
    expect(errors).toEqual([]);
  });

  it('collects errors across multiple offending fields', async () => {
    const errors = await collectSettingsPatternErrors({
      good: stringField({ pattern: '^[a-z0-9]+(_[a-z0-9]+)*$', max_length: 40 }),
      evil: stringField({ pattern: '([a-zA-Z]+)*$', max_length: 40 }),
      unbounded: stringField({ pattern: '^[a-z]+$' }),
    });
    expect(errors.some((e) => /settings\.evil.*ReDoS/i.test(e))).toBe(true);
    expect(errors.some((e) => /settings\.unbounded.*max_length/.test(e))).toBe(true);
    expect(errors.some((e) => /settings\.good/.test(e))).toBe(false);
  });
});
