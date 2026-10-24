import { describe, expect, it } from 'vitest';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

/**
 * `setUserSettingsInput` is a NARROW ALLOW-LIST, deliberately much smaller than
 * `userSettingsSchema`. tRPC validates the mutation input against it and STRIPS anything
 * not listed — so a key present in the storage schema but missing from the input schema is
 * silently discarded on write. The UI would look correct, the mutation would succeed, and
 * the setting would never persist. Both schemas are asserted here for that reason.
 */

describe('userSettingsSchema — isEarlyAdopter (storage shape)', () => {
  it('accepts and round-trips true', () => {
    const parsed = userSettingsSchema.parse({ isEarlyAdopter: true });
    expect(parsed.isEarlyAdopter).toBe(true);
  });

  it('accepts and round-trips false', () => {
    const parsed = userSettingsSchema.parse({ isEarlyAdopter: false });
    expect(parsed.isEarlyAdopter).toBe(false);
  });

  it('is optional — an existing settings blob without it still parses', () => {
    const parsed = userSettingsSchema.parse({ allowAds: true });
    expect(parsed.isEarlyAdopter).toBeUndefined();
    expect('isEarlyAdopter' in parsed).toBe(false);
  });

  it('rejects a non-boolean rather than coercing it', () => {
    // A coerced 'false' → true would enrol someone who never asked to be enrolled.
    expect(() => userSettingsSchema.parse({ isEarlyAdopter: 'true' })).toThrow();
    expect(() => userSettingsSchema.parse({ isEarlyAdopter: 1 })).toThrow();
    expect(() => userSettingsSchema.parse({ isEarlyAdopter: null })).toThrow();
  });

  it('does not disturb the sibling keys', () => {
    const parsed = userSettingsSchema.parse({
      isEarlyAdopter: true,
      allowAds: false,
      dismissedAlerts: ['a'],
    });
    expect(parsed).toMatchObject({
      isEarlyAdopter: true,
      allowAds: false,
      dismissedAlerts: ['a'],
    });
  });
});

describe('setUserSettingsInput — isEarlyAdopter (write allow-list)', () => {
  it('SURVIVES validation instead of being stripped', () => {
    // The whole point: an omitted key parses fine and vanishes, which is indistinguishable
    // from success at the call site. Assert the value is still there afterwards.
    const parsed = setUserSettingsInput.parse({ isEarlyAdopter: true });
    expect(parsed.isEarlyAdopter).toBe(true);
    expect('isEarlyAdopter' in parsed).toBe(true);
  });

  it('carries false through as well, so opting out is writable', () => {
    const parsed = setUserSettingsInput.parse({ isEarlyAdopter: false });
    expect(parsed.isEarlyAdopter).toBe(false);
    expect('isEarlyAdopter' in parsed).toBe(true);
  });

  it('rejects a non-boolean at the tRPC boundary', () => {
    expect(() => setUserSettingsInput.parse({ isEarlyAdopter: 'yes' })).toThrow();
    expect(() => setUserSettingsInput.parse({ isEarlyAdopter: 1 })).toThrow();
  });

  it('is still optional alongside the other writable settings', () => {
    const parsed = setUserSettingsInput.parse({ swipeGalleryCards: true });
    expect(parsed.isEarlyAdopter).toBeUndefined();
  });

  it('CONTROL: an unlisted key really is stripped', () => {
    // Positive control for the assertions above — proves the "survives validation" checks
    // can distinguish a listed key from an unlisted one, rather than passing vacuously.
    const parsed = setUserSettingsInput.parse({
      isEarlyAdopter: true,
      notARealSetting: true,
    } as never) as Record<string, unknown>;
    expect(parsed.isEarlyAdopter).toBe(true);
    expect('notARealSetting' in parsed).toBe(false);
  });
});
