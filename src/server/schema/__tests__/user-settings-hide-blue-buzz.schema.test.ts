import { describe, expect, it } from 'vitest';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

describe('hideBlueBuzzInHeader', () => {
  // The stored shape and the write input are hand-maintained separately. A key present only in
  // `userSettingsSchema` type-checks on read and silently never persists, because `setSettings`
  // strips it at the tRPC boundary before the handler runs. Typecheck catches this too; the test
  // exists because a stripped-key failure reads as "the toggle does nothing" in production.
  it('is accepted by the write input, not only by the stored shape', () => {
    expect(setUserSettingsInput.parse({ hideBlueBuzzInHeader: true })).toEqual({
      hideBlueBuzzInHeader: true,
    });
  });

  it('is declared on the stored shape as an optional boolean', () => {
    expect(userSettingsSchema.parse({ hideBlueBuzzInHeader: false }).hideBlueBuzzInHeader).toBe(
      false
    );
    expect(userSettingsSchema.parse({}).hideBlueBuzzInHeader).toBeUndefined();
  });
});
