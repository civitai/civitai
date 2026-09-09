import { describe, expect, it } from 'vitest';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

/**
 * `userSettingsSchema` (what is stored) and `setUserSettingsInput` (what a client may write) are
 * two hand-maintained objects. A key added to the first and not the second typechecks on read and
 * is stripped silently at the tRPC boundary, so the control reads as "does nothing" in production
 * with every test green. Same shape as `user-settings-hide-blue-buzz.schema.test.ts`.
 */

const config = { bar: ['home', 'models'], more: ['bounties'], hidden: ['posts'] };

describe('navigation settings', () => {
  it('round-trips through both schemas', () => {
    expect(userSettingsSchema.parse({ navigation: config }).navigation).toEqual(config);
    expect(setUserSettingsInput.parse({ navigation: config }).navigation).toEqual(config);
  });

  /**
   * "Reset to default" sends `{ navigation: undefined }` and depends on the key SURVIVING the
   * parse — `splitSettingsPatch` routes a present-but-undefined key to `remove`, which is what
   * deletes it from the blob. Drop the key here and reset becomes a green no-op that the
   * optimistic cache patch makes look like it worked until the next refresh.
   */
  it('keeps an explicitly-undefined navigation key so the reset can delete it', () => {
    expect('navigation' in setUserSettingsInput.parse({ navigation: undefined })).toBe(true);
  });

  it('rejects a key that is not a nav item', () => {
    expect(
      setUserSettingsInput.safeParse({ navigation: { ...config, bar: ['not-a-nav-item'] } }).success
    ).toBe(false);
  });

  it.each([
    ['across two zones', { bar: ['home'], more: ['home'], hidden: [] }],
    ['twice within one zone', { bar: ['home', 'home'], more: [], hidden: [] }],
  ])('rejects a key appearing %s', (_label, navigation) => {
    // A key in two places makes "the nearest placed sibling" ambiguous during resolution and
    // reaches React as a duplicate `key` prop.
    expect(setUserSettingsInput.safeParse({ navigation }).success).toBe(false);
  });

  it('accepts the showLabels toggle in both directions', () => {
    for (const showLabels of [true, false])
      expect(
        setUserSettingsInput.parse({ navigation: { ...config, showLabels } }).navigation?.showLabels
      ).toBe(showLabels);
  });
});
