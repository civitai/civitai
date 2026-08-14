import { describe, it, expect } from 'vitest';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { resolveAppsPageAccess } from '../resolveAppsPageAccess';

/**
 * `hasAppsStoreAccess` — the SHARED App-store visibility predicate.
 *
 * WHY IT EXISTS: the rule `appListings || appBlocks` was open-coded at six
 * places, and one of them — the `/apps/*` sub-nav (`AppsSubNav`) — had drifted to
 * `appBlocks` ALONE. A cohort holding `app-listings` without `app-blocks-enabled`
 * would therefore load `/apps` (the SSR resolver ORs both) and get NO
 * sub-navigation. Not reachable today (both flags resolve true for the current
 * mods + `app-dev-testers` cohort), but `app-listings` exists precisely so the
 * catalog can widen independently of the block runtime.
 *
 * These pin the predicate itself across the FULL 2×2 flag matrix, so the
 * behaviour is asserted in one place rather than re-derived at each call site.
 * The companion browser suite (`AppsSubNav.storeGate.browser.test.tsx`) pins the
 * sub-nav's rendered output for the same four combinations, and
 * `resolveAppsPageAccess.test.ts` (UNMODIFIED by this change) pins the SSR gate.
 */
describe('hasAppsStoreAccess — the 2×2 flag matrix', () => {
  it('both flags true → access', () => {
    expect(hasAppsStoreAccess({ appListings: true, appBlocks: true })).toBe(true);
  });

  it('appListings ONLY → access (the case AppsSubNav used to get wrong)', () => {
    expect(hasAppsStoreAccess({ appListings: true, appBlocks: false })).toBe(true);
    // …and with `appBlocks` absent from the object entirely.
    expect(hasAppsStoreAccess({ appListings: true })).toBe(true);
  });

  it('appBlocks ONLY → access (the OR-fallback that keeps today’s cohort in)', () => {
    expect(hasAppsStoreAccess({ appListings: false, appBlocks: true })).toBe(true);
    expect(hasAppsStoreAccess({ appBlocks: true })).toBe(true);
  });

  it('neither flag → NO access', () => {
    expect(hasAppsStoreAccess({ appListings: false, appBlocks: false })).toBe(false);
  });

  it('fails CLOSED on an absent / empty features object', () => {
    expect(hasAppsStoreAccess(undefined)).toBe(false);
    expect(hasAppsStoreAccess(null)).toBe(false);
    expect(hasAppsStoreAccess({})).toBe(false);
  });

  it('returns a real boolean, never the raw flag value', () => {
    // Callers use it in `enabled:` positions that are typed `boolean`, and the
    // old open-coded form (`features.appListings || features.appBlocks`) could
    // yield `undefined`. Assert the type, not just truthiness.
    expect(hasAppsStoreAccess({ appListings: undefined, appBlocks: undefined })).toBe(false);
    expect(typeof hasAppsStoreAccess({ appListings: true })).toBe('boolean');
    expect(typeof hasAppsStoreAccess({})).toBe('boolean');
  });
});

/**
 * 🔴 THE SEAM. The point of the extraction is that the SSR gate and the shared
 * predicate cannot disagree — a component tested in isolation and a resolver
 * tested in isolation can both be green while the pair is incoherent. This
 * asserts the RELATIONSHIP over the full matrix rather than either side alone,
 * so it fails if `resolveAppsPageAccess` is ever re-inlined and then edited.
 */
describe('resolveAppsPageAccess is EXACTLY hasAppsStoreAccess (no drift)', () => {
  const MATRIX: Array<{ appListings?: boolean; appBlocks?: boolean }> = [
    { appListings: true, appBlocks: true },
    { appListings: true, appBlocks: false },
    { appListings: false, appBlocks: true },
    { appListings: false, appBlocks: false },
    { appListings: true },
    { appBlocks: true },
    {},
  ];

  for (const features of MATRIX) {
    it(`agrees for ${JSON.stringify(features)}`, () => {
      const granted = hasAppsStoreAccess(features);
      const result = resolveAppsPageAccess({ features });
      expect('props' in result).toBe(granted);
      expect('notFound' in result).toBe(!granted);
    });
  }

  it('agrees on the nullish features cases too', () => {
    for (const features of [undefined, null] as const) {
      expect(hasAppsStoreAccess(features)).toBe(false);
      expect(resolveAppsPageAccess({ features })).toEqual({ notFound: true });
    }
  });
});
