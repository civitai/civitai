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
 * 🔴 THE THIRD TERM — `appListingsPublicExternal` (the EXTERNAL-ONLY cohort).
 *
 * Its holders are viewers the SERVER will serve a `kind='offsite'`-only catalog to
 * (`resolveStoreVisibilityScope` → `public-external`). Before it was added here,
 * a viewer whose ONLY qualification was that flag hit `notFound` at the page gate
 * and could never reach the store the server was ready to serve them — the gate and
 * the data path disagreeing about the same flag.
 *
 * The full 2×2×2 is asserted rather than the one interesting cell, because the
 * dangerous mistakes are the boring cells: an `&&` instead of an `||` (only the
 * both-true row would notice), or the term being dropped from one branch.
 */
describe('hasAppsStoreAccess — the external-only term (full 2×2×2)', () => {
  const BOOLS = [true, false] as const;
  for (const appListings of BOOLS)
    for (const appBlocks of BOOLS)
      for (const appListingsPublicExternal of BOOLS) {
        const expected = appListings || appBlocks || appListingsPublicExternal;
        it(`{listings:${appListings}, blocks:${appBlocks}, external:${appListingsPublicExternal}} → ${expected}`, () => {
          expect(hasAppsStoreAccess({ appListings, appBlocks, appListingsPublicExternal })).toBe(
            expected
          );
        });
      }

  it('🔴 the EXTERNAL flag ALONE grants access (the blocker this term removes)', () => {
    expect(hasAppsStoreAccess({ appListingsPublicExternal: true })).toBe(true);
    expect(
      hasAppsStoreAccess({ appListings: false, appBlocks: false, appListingsPublicExternal: true })
    ).toBe(true);
  });

  it('🔴 the external flag being FALSE cannot revoke either older flag', () => {
    // The `&&`/de-Morgan mutant: a viewer who qualifies via `appListings` or
    // `appBlocks` must keep access no matter what the new flag says.
    expect(hasAppsStoreAccess({ appListings: true, appListingsPublicExternal: false })).toBe(true);
    expect(hasAppsStoreAccess({ appBlocks: true, appListingsPublicExternal: false })).toBe(true);
  });

  it('still fails CLOSED when the new key is absent / undefined', () => {
    expect(hasAppsStoreAccess({ appListingsPublicExternal: undefined })).toBe(false);
    expect(hasAppsStoreAccess({ appListings: false, appBlocks: false })).toBe(false);
  });
});

/**
 * 🔴 THE SSR SEAM, EXTENDED TO THE NEW TERM. The block below (unchanged) pins the
 * 2×2; this pins the cells the third flag adds — above all "external ONLY reaches
 * /apps", which is the whole point of the change and which the original matrix
 * cannot express.
 */
describe('resolveAppsPageAccess agrees with the predicate on the external-only cells', () => {
  const MATRIX: Array<{
    appListings?: boolean;
    appBlocks?: boolean;
    appListingsPublicExternal?: boolean;
  }> = [
    { appListingsPublicExternal: true },
    { appListings: false, appBlocks: false, appListingsPublicExternal: true },
    { appListings: false, appBlocks: false, appListingsPublicExternal: false },
    { appListings: true, appBlocks: false, appListingsPublicExternal: true },
    { appListings: false, appBlocks: true, appListingsPublicExternal: false },
    { appListingsPublicExternal: undefined },
  ];

  for (const features of MATRIX) {
    it(`agrees for ${JSON.stringify(features)}`, () => {
      const granted = hasAppsStoreAccess(features);
      const result = resolveAppsPageAccess({ features });
      expect('props' in result).toBe(granted);
      expect('notFound' in result).toBe(!granted);
    });
  }

  it('🔴 external-only viewer reaches /apps — NOT notFound', () => {
    expect(resolveAppsPageAccess({ features: { appListingsPublicExternal: true } })).toEqual({
      props: {},
    });
  });

  it('🔴 a viewer qualifying via NOTHING still gets notFound', () => {
    expect(
      resolveAppsPageAccess({
        features: { appListings: false, appBlocks: false, appListingsPublicExternal: false },
      })
    ).toEqual({ notFound: true });
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
