import { describe, expect, it } from 'vitest';
import { canAccessAppsBuild, hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';

/**
 * The `/apps/build` gate, as a TRUTH TABLE over the whole flag space rather than a
 * handful of spot checks.
 *
 * The rule is `store && (author || getStarted)`. Three independent inputs decide it —
 * store access (itself an OR over three flags), the author capability (itself an OR over
 * `isModerator` and `appBlocksAuthor`), and the get-started kill switch — so there are
 * eight combinations of the three TERMS and the table below enumerates all of them. A
 * spot check would pass against `store || (author && getStarted)`, `author || getStarted`
 * and several other wrong shapes; the full table does not.
 */

type Flags = Parameters<typeof canAccessAppsBuild>[1];
type User = Parameters<typeof canAccessAppsBuild>[0];

const MOD: User = { isModerator: true };
const PLAIN: User = { isModerator: false };

/** Build a flag object that produces the three TERMS with the given truth values. */
function flags(opts: { store: boolean; author: boolean; getStarted: boolean }): Flags {
  return {
    appListings: opts.store,
    appBlocksAuthor: opts.author,
    appBlocksGetStarted: opts.getStarted,
  };
}

describe('canAccessAppsBuild — the full 2×2×2 term table', () => {
  const cases: Array<{ store: boolean; author: boolean; getStarted: boolean; expected: boolean }> =
    [
      { store: false, author: false, getStarted: false, expected: false },
      { store: false, author: false, getStarted: true, expected: false },
      { store: false, author: true, getStarted: false, expected: false },
      { store: false, author: true, getStarted: true, expected: false },
      { store: true, author: false, getStarted: false, expected: false },
      { store: true, author: false, getStarted: true, expected: true },
      { store: true, author: true, getStarted: false, expected: true },
      { store: true, author: true, getStarted: true, expected: true },
    ];

  it.each(cases)(
    'store=$store author=$author getStarted=$getStarted → $expected',
    ({ store, author, getStarted, expected }) => {
      expect(canAccessAppsBuild(PLAIN, flags({ store, author, getStarted }))).toBe(expected);
    }
  );

  it('🔴 the STORE term is a hard AND — it can veto BOTH of the other two', () => {
    // Named separately from the table because it is the one term whose removal would
    // leave a mutant that the "obvious" cases still pass: `author || getStarted` agrees
    // with the real rule on every row where store is true, i.e. on the only rows anyone
    // exercises by hand. These two rows are what kill it.
    expect(canAccessAppsBuild(MOD, flags({ store: false, author: true, getStarted: true }))).toBe(
      false
    );
    expect(
      canAccessAppsBuild(PLAIN, flags({ store: false, author: false, getStarted: true }))
    ).toBe(false);
  });

  it('🔴 the AUTHOR and GET-STARTED terms are an OR, not an AND', () => {
    // Kills `store && author && getStarted`, which agrees with the real rule on 6 of the
    // 8 rows above.
    expect(canAccessAppsBuild(PLAIN, flags({ store: true, author: true, getStarted: false }))).toBe(
      true
    );
    expect(canAccessAppsBuild(PLAIN, flags({ store: true, author: false, getStarted: true }))).toBe(
      true
    );
  });
});

describe('the author term routes through isAppDeveloper, so moderators are a hard floor', () => {
  it('a moderator passes on store access ALONE — no author flag, no get-started', () => {
    expect(canAccessAppsBuild(MOD, flags({ store: true, author: false, getStarted: false }))).toBe(
      true
    );
  });

  it('…and a non-mod in the identical flag state does NOT', () => {
    // The discriminating control for the case above: without it, that assertion passes
    // for a predicate that ignores the user entirely and just reads `store`.
    expect(
      canAccessAppsBuild(PLAIN, flags({ store: true, author: false, getStarted: false }))
    ).toBe(false);
  });

  it('a moderator is still vetoed by the store term', () => {
    expect(canAccessAppsBuild(MOD, flags({ store: false, author: false, getStarted: false }))).toBe(
      false
    );
  });
});

describe('each of the three STORE flags satisfies the store term on its own', () => {
  // The store term is `hasAppsStoreAccess`, an OR over three flags. Pinned here because
  // a `canAccessAppsBuild` that read `features.appBlocks` directly instead of calling the
  // shared predicate would pass every other test in this file.
  it.each(['appListings', 'appBlocks', 'appListingsPublicExternal'] as const)(
    '%s alone + get-started admits',
    (flag) => {
      const f = { [flag]: true, appBlocksGetStarted: true } as Flags;
      expect(hasAppsStoreAccess(f)).toBe(true);
      expect(canAccessAppsBuild(PLAIN, f)).toBe(true);
    }
  );

  it('a NON-store App-Blocks flag does NOT satisfy it (negative control)', () => {
    // `appBlocksPages` is a real sibling flag that is not part of store visibility.
    // Without this, the loop above would pass for a predicate that treats any truthy
    // property as store access.
    expect(
      canAccessAppsBuild(PLAIN, { appBlocksPages: true, appBlocksGetStarted: true } as Flags)
    ).toBe(false);
  });
});

describe('fails CLOSED', () => {
  it.each([
    ['undefined features', undefined],
    ['null features', null],
    ['empty features', {}],
  ] as const)('%s → false, even for a moderator', (_label, f) => {
    expect(canAccessAppsBuild(MOD, f as Flags)).toBe(false);
  });

  it('an absent user is not an error — it is just not an author', () => {
    expect(
      canAccessAppsBuild(undefined, flags({ store: true, author: false, getStarted: true }))
    ).toBe(true);
    expect(
      canAccessAppsBuild(undefined, flags({ store: true, author: false, getStarted: false }))
    ).toBe(false);
  });
});

/**
 * 🔴 THE SEAM THIS WHOLE CONSOLIDATION EXISTS TO CLOSE, asserted as a RELATIONSHIP
 * between two modules rather than as a property of either.
 *
 * The defect class is a tab offered to a cohort whose destination page answers
 * `notFound` — #3899 for "Create", and again as a deploy-blocking finding on PR #4668.
 * Both times the tab's rule and the page's rule were written separately and drifted.
 * These assert that the two can no longer disagree, in BOTH directions, across the whole
 * flag space.
 *
 * ⚠️ SCOPE, STATED HONESTLY: this pins the tab's PREDICATE against the page's RESOLVER.
 * It cannot see that `SUB_NAV_LINKS`'s Build row actually calls `c.canBuild` — that is a
 * source fact, owned by `appsBuildGateCallSites.test.ts`, and a behavioural fact, owned
 * by `AppsSubNav.storeGate.browser.test.tsx`. Three checks, three different failure
 * modes; do not read this file as covering all of it.
 */
describe('🔴 the Build tab predicate and the /apps/build page gate cannot disagree', () => {
  const users: Array<[string, User]> = [
    ['moderator', MOD],
    ['plain user', PLAIN],
    ['logged out', null],
  ];
  const combos = [false, true].flatMap((store) =>
    [false, true].flatMap((author) =>
      [false, true].map((getStarted) => ({ store, author, getStarted }))
    )
  );

  for (const [label, user] of users) {
    it.each(combos)(`${label}: store=$store author=$author getStarted=$getStarted`, (c) => {
      const f = flags(c);
      const tabVisible = canAccessAppsBuild(user, f);
      const pageAdmits = 'props' in resolveBuildPageAccess({ features: f, user });
      expect(
        pageAdmits,
        tabVisible
          ? 'the Build TAB is visible to a viewer the PAGE answers notFound for — this is ' +
              'the #3899 / #4668 defect, back again.'
          : 'the PAGE admits a viewer the Build TAB is hidden from — the mirror defect: a ' +
              'reachable surface with no navigation to it.'
      ).toBe(tabVisible);
    });
  }
});

/**
 * 🔴 THE MARKETPLACE HALF OF THE SAME RULE — and this is the assertion with a MEASURED
 * red on pre-change code, so it is the regression coverage in this file rather than an
 * invariant guard.
 *
 * Before this change the Marketplace row was `visible: () => true` while `/apps` gates on
 * `resolveAppsPageAccess`. That mismatch was KNOWN and deliberately left open — written
 * up on `pages/apps/get-started.tsx`, on the row itself, and on the container — because
 * closing it would have dropped the get-started-only cohort to one tab, where the `< 2`
 * collapse deletes the whole bar. Making "Build" store-gated removed that objection.
 */
describe('🔴 the Marketplace tab predicate and the /apps page gate cannot disagree', () => {
  const combos = [false, true].flatMap((appListings) =>
    [false, true].flatMap((appBlocks) =>
      [false, true].map((appListingsPublicExternal) => ({
        appListings,
        appBlocks,
        appListingsPublicExternal,
      }))
    )
  );

  it.each(combos)(
    'appListings=$appListings appBlocks=$appBlocks external=$appListingsPublicExternal',
    (f) => {
      const tabVisible = hasAppsStoreAccess(f);
      const pageAdmits = 'props' in resolveAppsPageAccess({ features: f });
      expect(
        pageAdmits,
        'the Marketplace tab and `/apps` disagree about this viewer. The tab is ' +
          '`visible: (_s, c) => c.canSeeStore`, and `canSeeStore` must stay ' +
          '`hasAppsStoreAccess(features)` — the same predicate the page resolver calls.'
      ).toBe(tabVisible);
    }
  );

  it('positive control: at least one combination is admitted and one is refused', () => {
    // Without this, the loop above passes vacuously if BOTH sides became constant.
    expect(combos.filter((f) => hasAppsStoreAccess(f)).length).toBeGreaterThan(0);
    expect(combos.filter((f) => !hasAppsStoreAccess(f)).length).toBeGreaterThan(0);
  });
});
