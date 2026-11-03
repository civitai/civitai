import { describe, expect, it } from 'vitest';
import {
  activeAppsSection,
  APPS_NAV_MIN_SECTIONS,
  appsSectionGroups,
  appsSections,
  EMPTY_APPS_NAV_SUMMARY,
  getAppsSectionHref,
  isActiveAppsRoute,
  NO_APPS_NAV_CAPABILITIES,
  visibleAppsSections,
} from '~/components/Apps/apps-sections';

/**
 * The `/apps` rail after the home/store split: `/apps` is "My apps", `/apps/store` is
 * "Marketplace". `current` is always a Next `router.pathname` (a ROUTE, no query string).
 */

const STORE_ONLY = { ...NO_APPS_NAV_CAPABILITIES, canSeeStore: true };

describe('which section is lit', () => {
  it.each([
    ['/apps', 'my-apps'],
    ['/apps/store', 'marketplace'],
    ['/apps/activity', 'activity'],
    ['/apps/build', 'build'],
  ])('%s → %s', (current, id) => {
    expect(activeAppsSection(current)?.id).toBe(id);
  });

  it('🔴 /apps lights ONLY My apps — Marketplace is not also lit', () => {
    const lit = appsSections.filter((s) => isActiveAppsRoute(getAppsSectionHref(s), '/apps'));
    expect(lit.map((s) => s.id)).toEqual(['my-apps']);
  });

  it('🔴 /apps/store lights Marketplace and NOT My apps', () => {
    const lit = appsSections.filter((s) => isActiveAppsRoute(getAppsSectionHref(s), '/apps/store'));
    expect(lit.map((s) => s.id)).toEqual(['marketplace']);
  });

  it('a store URL with filters (the query never reaches pathname) still lights Marketplace', () => {
    // The rail reads `router.pathname`, which for `/apps/store?category=x` is `/apps/store`.
    // The raw URL is asserted too, so a future switch to `asPath` is caught here.
    expect(activeAppsSection('/apps/store')?.id).toBe('marketplace');
    expect(isActiveAppsRoute('/apps/store', '/apps/store?category=x')).toBe(false);
  });

  it('🔴 a store DETAIL page does not light Marketplace by prefix accident', () => {
    // `/apps/store` is a string prefix of `/apps/store-preview/...`; the `/` in the match is
    // what keeps them apart.
    expect(isActiveAppsRoute('/apps/store', '/apps/store-preview/[slug]')).toBe(false);
    expect(isActiveAppsRoute('/apps/store', '/apps/store-preview/foo')).toBe(false);
    expect(activeAppsSection('/apps/store-preview/[slug]')).toBeNull();
  });

  it('a deep run route lights nothing (neither home nor store)', () => {
    expect(activeAppsSection('/apps/run/[slug]/[[...path]]')).toBeNull();
  });
});

describe('the registry', () => {
  it('My apps is the first entry, at /apps; Marketplace is at /apps/store', () => {
    expect(appsSections[0].id).toBe('my-apps');
    expect(getAppsSectionHref(appsSections[0])).toBe('/apps');
    const market = appsSections.find((s) => s.id === 'marketplace');
    expect(market && getAppsSectionHref(market)).toBe('/apps/store');
  });

  it('My apps renders first: its group leads the group order', () => {
    expect(appsSectionGroups[0].id).toBe(appsSections[0].group);
  });
});

describe('visibility', () => {
  it('🔴 My apps and Marketplace are both visible whenever the store is, and neither without it', () => {
    const ids = (c: typeof STORE_ONLY) =>
      visibleAppsSections(EMPTY_APPS_NAV_SUMMARY, c).map((s) => s.id);
    expect(ids(STORE_ONLY)).toEqual(['my-apps', 'marketplace']);
    expect(ids(NO_APPS_NAV_CAPABILITIES)).toEqual([]);
  });

  it('the store-only cohort now clears the rail floor (two destinations, not one)', () => {
    expect(visibleAppsSections(EMPTY_APPS_NAV_SUMMARY, STORE_ONLY).length).toBeGreaterThanOrEqual(
      APPS_NAV_MIN_SECTIONS
    );
  });

  it('a viewer without store access but with installs still falls below the floor', () => {
    const shown = visibleAppsSections(
      { ...EMPTY_APPS_NAV_SUMMARY, hasInstalls: true },
      NO_APPS_NAV_CAPABILITIES
    );
    expect(shown.map((s) => s.id)).toEqual(['activity']);
    expect(shown.length).toBeLessThan(APPS_NAV_MIN_SECTIONS);
  });
});
