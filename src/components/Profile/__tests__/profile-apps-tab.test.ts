import { describe, expect, it } from 'vitest';
import { canShowProfileAppsTab } from '~/components/Profile/profile-apps-tab';

/**
 * The profile "Apps" tab (and the `/user/<name>/apps` page, which reads the same predicate) is
 * shown only to a viewer who can see the app store, and never on a banned account's profile.
 */
describe('🔴 canShowProfileAppsTab', () => {
  const active = { bannedAt: null };
  const banned = { bannedAt: new Date('2026-01-02T00:00:00Z') };

  it.each([
    ['appListings', { appListings: true }],
    ['appBlocks', { appBlocks: true }],
    ['appListingsPublicExternal', { appListingsPublicExternal: true }],
  ])('shown with store access through %s', (_flag, features) => {
    expect(canShowProfileAppsTab(features, active)).toBe(true);
  });

  it('🔴 hidden without any store flag', () => {
    expect(canShowProfileAppsTab({}, active)).toBe(false);
    expect(
      canShowProfileAppsTab(
        { appListings: false, appBlocks: false, appListingsPublicExternal: false },
        active
      )
    ).toBe(false);
    expect(canShowProfileAppsTab(undefined, active)).toBe(false);
  });

  it('🔴 hidden on a banned profile, even with store access', () => {
    expect(canShowProfileAppsTab({ appListings: true }, banned)).toBe(false);
  });

  it('shown while the profile is still loading (no user yet), like the other tabs', () => {
    expect(canShowProfileAppsTab({ appListings: true }, undefined)).toBe(true);
  });
});
