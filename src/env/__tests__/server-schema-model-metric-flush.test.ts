import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// Follow-up to #3243 — harden the SEARCH_INDEX_MODEL_METRIC_FLUSH_INTERVAL_MS knob.
// Before: z.coerce.number().int().positive().default(45m) — a 0/empty/float/garbage
// value (e.g. a "disable debounce" attempt) failed validation, and because the whole
// serverSchema throws on any invalid field (src/env/server.ts) that crashed the ENTIRE
// app boot, not just search.
// After:  .int().min(60_000).catch(45m) — any invalid/out-of-range/garbage value
// falls back to the 45m default rather than throwing; valid in-range values pass through.
const DEFAULT = 45 * 60 * 1000;
const field = serverSchema.shape.SEARCH_INDEX_MODEL_METRIC_FLUSH_INTERVAL_MS;

describe('SEARCH_INDEX_MODEL_METRIC_FLUSH_INTERVAL_MS env fail-soft', () => {
  it('falls back to the default for empty/garbage/out-of-range values (never throws)', () => {
    // '' and '0' coerce to 0 (a plausible "disable debounce" attempt); '1000.5' is a
    // float; 'abc' is non-numeric; '30000' is below the 1-minute floor.
    for (const bad of ['', '0', '-1', '1000.5', 'abc', '30000']) {
      expect(() => field.parse(bad)).not.toThrow();
      expect(field.parse(bad), `expected fallback for ${JSON.stringify(bad)}`).toBe(DEFAULT);
    }
  });

  it('falls back to the default when undefined (missing)', () => {
    expect(field.parse(undefined)).toBe(DEFAULT);
  });

  it('passes through valid in-range values', () => {
    expect(field.parse('60000')).toBe(60000); // 1-minute floor inclusive
    expect(field.parse('2700000')).toBe(DEFAULT); // 45m
    expect(field.parse('5400000')).toBe(5400000); // 90m
  });
});
