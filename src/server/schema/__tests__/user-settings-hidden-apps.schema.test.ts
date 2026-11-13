import { describe, expect, it } from 'vitest';
import { myAppsHideInputSchema } from '~/server/schema/blocks/app-listing-read.schema';
import {
  hiddenAppsSettingSchema,
  setUserSettingsInput,
  userSettingsSchema,
} from '~/server/schema/user.schema';
import { HIDDEN_APPS_MAX } from '~/shared/utils/my-apps-hidden';

const HIDE = '2026-10-10T11:22:33.000Z';

describe('User.settings.hiddenApps — the stored shape', () => {
  it('accepts a slug → ISO datetime map, and is optional', () => {
    expect(
      userSettingsSchema.parse({ hiddenApps: { 'pixel-forge': HIDE, 'tag-wizard': HIDE } })
        .hiddenApps
    ).toEqual({ 'pixel-forge': HIDE, 'tag-wizard': HIDE });
    expect(userSettingsSchema.parse({}).hiddenApps).toBeUndefined();
  });

  it.each([
    ['a non-date value', { 'pixel-forge': 'yesterday' }],
    ['a numeric value', { 'pixel-forge': 1760095353000 }],
    ['an empty slug', { '': HIDE }],
    ['a slug past 64 chars', { ['x'.repeat(65)]: HIDE }],
    ['an array', [HIDE]],
    ['a string', HIDE],
  ])('rejects %s', (_l, value) => {
    expect(() => userSettingsSchema.parse({ hiddenApps: value })).toThrow();
  });

  // TYPE-LEVEL ONLY, not the enforced cap. `hiddenAppsSettingSchema` types the stored key;
  // no write path parses the blob through it (the hide is an atomic per-slug SQL merge). The
  // RUNTIME cap is `hiddenAppsOverflow` applied by `hideMyApp`, covered by the PGlite test
  // (`my-apps-hidden.behavior.test.ts`). This pins only that the declared type agrees with it.
  it('the declared type agrees with the cap (HIDDEN_APPS_MAX entries pass, one more does not)', () => {
    const map = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`app-${i}`, HIDE]));
    expect(hiddenAppsSettingSchema.safeParse(map(HIDDEN_APPS_MAX)).success).toBe(true);
    expect(hiddenAppsSettingSchema.safeParse(map(HIDDEN_APPS_MAX + 1)).success).toBe(false);
  });

  it('🔴 is NOT client-writable through user.setSettings (only the dedicated mutations write it)', () => {
    // `setUserSettingsInput` strips unknown keys; a client must not be able to replace the
    // whole map (and so bypass the per-slug atomic write and the cap) through the generic path.
    expect(setUserSettingsInput.parse({ hiddenApps: { 'pixel-forge': HIDE } })).not.toHaveProperty(
      'hiddenApps'
    );
  });
});

describe('appListings.hideMyApp / unhideMyApp input', () => {
  it('accepts a slug, trimmed', () => {
    expect(myAppsHideInputSchema.parse({ slug: '  pixel-forge ' })).toEqual({
      slug: 'pixel-forge',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { slug: '' }],
    ['whitespace only', { slug: '   ' }],
    ['too long', { slug: 'x'.repeat(65) }],
    ['not a string', { slug: 42 }],
  ])('rejects a slug that is %s', (_l, input) => {
    expect(myAppsHideInputSchema.safeParse(input).success).toBe(false);
  });
});
