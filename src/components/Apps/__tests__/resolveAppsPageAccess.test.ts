import { describe, it, expect } from 'vitest';
import { resolveAppsPageAccess } from '../resolveAppsPageAccess';

/**
 * F-E E1 + W13 PR-W1a/D8 — SSR gate-ordering + decoupling invariant for /apps.
 *
 * The marketplace is anon-capable but stays DARK behind the store-visibility
 * flag. W13 repoints that gate onto the dedicated `appListings` flag WITH an
 * OR-fallback to `appBlocks` (access = `appListings || appBlocks`). These tests
 * pin the GATING INVARIANT so it FAILS if the gate is reordered, removed, the
 * OR-fallback is dropped, or a session→login redirect is reintroduced:
 *   - Neither flag → notFound, REGARDLESS of session (gate is the only control,
 *     and it's a hard notFound — never a login redirect).
 *   - `appListings`-only true → renders (the new dedicated visibility flag).
 *   - `appBlocks`-only true → renders (the OR-FALLBACK — keeps the current
 *     mods+testers cohort in while `app-listings` doesn't exist yet).
 *   - Flag granted + NO session → renders (the dark anon read path).
 */

describe('resolveAppsPageAccess — gating invariant', () => {
  it('neither flag → notFound (gate intact, even with no session)', () => {
    expect(resolveAppsPageAccess({ features: { appBlocks: false } })).toEqual({ notFound: true });
    expect(
      resolveAppsPageAccess({ features: { appBlocks: false, appListings: false } })
    ).toEqual({ notFound: true });
  });

  it('undefined/null features → notFound (fails closed)', () => {
    expect(resolveAppsPageAccess({ features: undefined })).toEqual({ notFound: true });
    expect(resolveAppsPageAccess({ features: null })).toEqual({ notFound: true });
    expect(resolveAppsPageAccess({ features: {} })).toEqual({ notFound: true });
  });

  it('appListings-only true → renders (dedicated visibility flag lit)', () => {
    expect(
      resolveAppsPageAccess({ features: { appListings: true, appBlocks: false } })
    ).toEqual({ props: {} });
    // and with appBlocks entirely absent from the object
    expect(resolveAppsPageAccess({ features: { appListings: true } })).toEqual({ props: {} });
  });

  it('appBlocks-only true → renders (the OR-fallback preserves the current cohort)', () => {
    // The load-bearing dark-decoupling case: `app-listings` doesn't exist yet, so
    // `appListings` is false but `appBlocks` still grants today's mods+testers.
    expect(
      resolveAppsPageAccess({ features: { appBlocks: true, appListings: false } })
    ).toEqual({ props: {} });
    expect(resolveAppsPageAccess({ features: { appBlocks: true } })).toEqual({ props: {} });
  });

  it('flag granted + NO session → renders (the dark anon read path, no login redirect)', () => {
    const result = resolveAppsPageAccess({ features: { appBlocks: true } });
    expect(result).toEqual({ props: {} });
    // Critically: it must NOT be a redirect. The old behavior bounced anon to
    // /login; E1 removes that so the page renders behind the flag.
    expect(result).not.toHaveProperty('redirect');
    expect(result).not.toHaveProperty('notFound');
  });
});

/**
 * F-E E2 — the per-app detail page (`/apps/<appBlockId>`) reuses the SAME
 * `resolveAppsPageAccess` gate as the marketplace index. These cases pin that
 * the detail page is flag-gated FIRST (no session→login redirect, no
 * isModerator belt), so a real anon/non-mod gets `notFound` today and the page
 * is anon-capable-but-dark — identical to the index. (Belt-and-suspenders: if
 * the detail page ever swaps to a different/looser resolver, this fails.)
 */
describe('resolveAppsPageAccess — detail page (/apps/[appBlockId]) reuses the index gate', () => {
  it('no flag + no session → notFound (the detail page stays dark for real anon)', () => {
    expect(resolveAppsPageAccess({ features: { appBlocks: false } })).toEqual({ notFound: true });
    expect(resolveAppsPageAccess({ features: undefined })).toEqual({ notFound: true });
  });

  it('flag granted + no session → renders (dark anon read path, never a redirect)', () => {
    const result = resolveAppsPageAccess({ features: { appBlocks: true } });
    expect(result).toEqual({ props: {} });
    expect(result).not.toHaveProperty('redirect');
    expect(result).not.toHaveProperty('notFound');
  });
});
