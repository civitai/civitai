import { describe, expect, it } from 'vitest';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import type { NavConfig } from '~/components/HomeContentToggle/resolve-nav-items';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

// The music nav item next to the users' saved layouts it has to live with.

const barKeys = (features: Partial<FeatureAccess>, config?: NavConfig) =>
  resolveNavItems(
    navRegistry,
    { features: features as FeatureAccess, isAuthed: true },
    config
  ).bar.map((entry) => entry.key);

// Saved before the music item existed.
const savedBefore: NavConfig = { bar: ['home', 'videos', 'images'], more: [], hidden: ['posts'] };
const savedWithMusic: NavConfig = { bar: ['home', 'music', 'videos'], more: [], hidden: [] };

describe('the music nav item', () => {
  it('a layout saved without it still parses and keeps its order, with music beside videos', () => {
    expect(userSettingsSchema.parse({ navigation: savedBefore }).navigation).toEqual(savedBefore);
    const bar = barKeys({ music: true }, savedBefore);
    // The saved items keep their saved order; music lands right after videos.
    expect(bar.filter((key) => savedBefore.bar.includes(key))).toEqual(savedBefore.bar);
    expect(bar[bar.indexOf('videos') + 1]).toBe('music');
  });

  it('shows only with the music flag on', () => {
    expect(barKeys({ music: true })).toContain('music');
    expect(barKeys({})).not.toContain('music');
  });

  it('a layout saved with it still parses, and drops it with the flag off', () => {
    expect(setUserSettingsInput.parse({ navigation: savedWithMusic }).navigation).toEqual(
      savedWithMusic
    );
    expect(userSettingsSchema.parse({ navigation: savedWithMusic }).navigation).toEqual(
      savedWithMusic
    );
    const bar = barKeys({}, savedWithMusic);
    expect(bar).not.toContain('music');
    expect(bar.filter((key) => savedWithMusic.bar.includes(key))).toEqual(['home', 'videos']);
  });
});
