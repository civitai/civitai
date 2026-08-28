import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

/**
 * CREATE_IMAGE_VERIFY_MEDIA_ENFORCE gates whether `createImage` REJECTS a row whose
 * media the store answered was absent. It ships OFF: the probe runs and logs, but
 * nothing fails, so the `absent` rate can be measured against the total before
 * enforcement.
 *
 * 🔴 Why this is tested at the SCHEMA and not left to inspection. The service reads
 * `env.CREATE_IMAGE_VERIFY_MEDIA_ENFORCE === true`. If the schema yielded the STRING
 * `'true'` instead of a boolean, that comparison would be false forever and the gate
 * could never be turned on — an inert config key that reads as enabled and does
 * nothing, with no error anywhere. The values below are hand-written literals for what
 * a deployment actually sets, not values recomputed from the schema.
 *
 * Sibling of server-schema-upload-complete-verify.test.ts, which pins the same
 * property for the multipart-completion gate this one is modelled on.
 */
const field = serverSchema.shape.CREATE_IMAGE_VERIFY_MEDIA_ENFORCE;

describe('CREATE_IMAGE_VERIFY_MEDIA_ENFORCE env gate', () => {
  it('defaults to false when unset — enforcement is opt-in', () => {
    expect(field.parse(undefined)).toBe(false);
  });

  it("yields a real BOOLEAN true for the string 'true', so `=== true` can fire", () => {
    const parsed = field.parse('true');
    expect(parsed).toBe(true);
    expect(typeof parsed).toBe('boolean');
  });

  it.each(['', 'false', 'FALSE', 'no', '0', 'yes', 'garbage', 'TRUE '])(
    'treats %j as NOT enforcing — a malformed value lands on observe-only, never on rejecting',
    (value) => {
      const parsed = field.parse(value);
      expect(parsed).toBe(false);
      expect(typeof parsed).toBe('boolean');
    }
  );

  it('accepts a real boolean true as well', () => {
    expect(field.parse(true)).toBe(true);
  });
});
