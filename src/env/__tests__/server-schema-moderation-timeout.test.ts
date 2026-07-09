import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// #2734 — bound the EXTERNAL_MODERATION_TIMEOUT_MS knob.
// Before: z.coerce.number().int().positive().catch(5000) — no upper bound, so
// `=1e10` → ~116-day timeout (re-introduces the unbounded park) and tiny values
// abort before moderation can respond (silently skip moderation).
// After:  .int().min(100).max(60000).catch(5000) — any out-of-range/garbage/empty
// value falls back to 5000; valid in-range values pass through.
const field = serverSchema.shape.EXTERNAL_MODERATION_TIMEOUT_MS;

describe('EXTERNAL_MODERATION_TIMEOUT_MS env clamp', () => {
  it('falls back to 5000 for empty/garbage/out-of-range values', () => {
    for (const bad of ['', '0', '-1', '1e10', 'abc', '99', '60001']) {
      expect(field.parse(bad), `expected fallback for ${JSON.stringify(bad)}`).toBe(5000);
    }
  });

  it('falls back to 5000 when undefined (missing)', () => {
    expect(field.parse(undefined)).toBe(5000);
  });

  it('passes through valid in-range values', () => {
    expect(field.parse('8000')).toBe(8000);
    expect(field.parse('100')).toBe(100); // lower bound inclusive
    expect(field.parse('60000')).toBe(60000); // upper bound inclusive
  });
});
