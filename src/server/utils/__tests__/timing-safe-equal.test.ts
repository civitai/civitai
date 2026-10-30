import { describe, expect, it } from 'vitest';
import { timingSafeEqualStrings } from '~/server/utils/timing-safe-equal';

describe('timingSafeEqualStrings', () => {
  it('is true only for equal strings', () => {
    expect(timingSafeEqualStrings('abc123', 'abc123')).toBe(true);
    expect(timingSafeEqualStrings('abc123', 'abc124')).toBe(false);
  });

  it('is false, without throwing, for strings of different lengths or a missing one', () => {
    expect(timingSafeEqualStrings('abc123', 'abc')).toBe(false);
    expect(timingSafeEqualStrings('abc', 'abc123')).toBe(false);
    expect(timingSafeEqualStrings('abc', undefined)).toBe(false);
  });
});
