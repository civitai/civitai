import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

/**
 * UPLOAD_COMPLETE_VERIFY_ENFORCE gates whether /api/upload/complete REJECTS a
 * completion whose object it could not find. It ships OFF: the probe runs and logs,
 * but nothing fails, so the false-reject rate can be measured before enforcement.
 *
 * 🔴 Why this is tested at the SCHEMA and not left to inspection. The handler reads
 * `env.UPLOAD_COMPLETE_VERIFY_ENFORCE === true`. If the schema yielded the STRING
 * `'true'` instead of a boolean, that comparison would be false forever and the gate
 * could never be turned on — an inert config key that reads as enabled and does
 * nothing, with no error anywhere. The values below are hand-written literals for what
 * the deployment actually sets, not values recomputed from the schema.
 *
 * The two rows that matter operationally:
 *   nothing set        → false  (the shipped default; observe-only)
 *   the string 'true'  → true   (a real boolean, so `=== true` fires)
 */
const field = serverSchema.shape.UPLOAD_COMPLETE_VERIFY_ENFORCE;

describe('UPLOAD_COMPLETE_VERIFY_ENFORCE env gate', () => {
  it('defaults to false when unset — enforcement is opt-in', () => {
    expect(field.parse(undefined)).toBe(false);
  });

  it("yields a real BOOLEAN true for the string 'true', so `=== true` can fire", () => {
    const parsed = field.parse('true');
    expect(parsed).toBe(true);
    expect(typeof parsed).toBe('boolean');
  });

  it.each(['', 'false', 'FALSE', 'no', '0', 'yes', 'garbage'])(
    'treats %j as NOT enforcing (only an unambiguous opt-in enables rejection)',
    (value) => {
      expect(field.parse(value)).toBe(false);
    }
  );

  it('accepts a real boolean true as well', () => {
    expect(field.parse(true)).toBe(true);
  });
});
