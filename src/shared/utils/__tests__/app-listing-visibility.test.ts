import { describe, expect, it } from 'vitest';

import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';
import {
  APP_LISTING_VISIBILITIES,
  APP_LISTING_VISIBILITY_RANK,
  isAppListingVisibility,
  isListingAudienceFloor,
  isVisibilityEligibleListingStatus,
  listingVisibilityRank,
  maxVisibilityForStatus,
  listingVisibleInStore,
  narrowListingVisibility,
  parseStoredVisibility,
  VISIBILITY_ELIGIBLE_LISTING_STATUSES,
  viewerSeesListingVisibility,
  visibilitiesVisibleTo,
  type AppListingVisibility,
  type ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';

/**
 * The per-listing visibility VALUE MODEL.
 *
 * 🔴 EVERY CASE HERE IS LABELLED [NEW] OR [INV], AND NONE IS REGRESSION COVERAGE. The
 * module is introduced by this change, so there is no base ref at which any of these can be
 * watched to fail — a test of a symbol that does not exist does not go red, it fails to
 * IMPORT, and reporting that as "red at base" would be laundering a vacuous green. What
 * stands behind these instead is a mutation sweep over the implementation, recorded in the
 * PR body: each assertion below was confirmed to die on a specific, named mutation of the
 * code it covers.
 *
 * [NEW] — pins behaviour this change introduces.
 * [INV] — pins a property of the value set that a LATER edit could break (a rank collision,
 *         a widened eligibility allowlist, a second literal list drifting from the enum).
 */

const FLOORS: ListingAudienceFloor[] = ['moderators', 'testers', 'public'];

describe('the visibility value set', () => {
  it('[INV] is exactly the four decided levels, in widening order', () => {
    // The enum is operator-decided. A fifth value, a rename, or a reorder is a product
    // decision and must be loud here rather than inferred from a rank map.
    expect([...APP_LISTING_VISIBILITIES]).toEqual(['private', 'moderators', 'testers', 'public']);
  });

  it('[INV] every rank is DISTINCT, so the comparison is well-defined', () => {
    // 🔴 THE PROPERTY `viewerSeesListingVisibility` RESTS ON. Two levels sharing a rank
    // would make `>=` admit a cohort to a level it is not in, in whichever direction the
    // collision fell — and nothing else in the module would notice.
    const ranks = APP_LISTING_VISIBILITIES.map(listingVisibilityRank);
    expect(new Set(ranks).size).toBe(APP_LISTING_VISIBILITIES.length);
    // And the order is the WIDENING order, not an arbitrary numbering: each level must
    // outrank the one before it.
    for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it('[INV] the rank map covers the set and nothing else', () => {
    expect(Object.keys(APP_LISTING_VISIBILITY_RANK).sort()).toEqual(
      [...APP_LISTING_VISIBILITIES].sort()
    );
  });

  it('[NEW] the membership test accepts every member and rejects everything else', () => {
    for (const v of APP_LISTING_VISIBILITIES) expect(isAppListingVisibility(v)).toBe(true);
    for (const bad of [undefined, null, '', 'PUBLIC', 'moderator', 'everyone', 0, {}, []])
      expect(isAppListingVisibility(bad)).toBe(false);
  });
});

describe('narrowListingVisibility — fail-closed', () => {
  it('[NEW] passes a real level through unchanged', () => {
    for (const v of APP_LISTING_VISIBILITIES) expect(narrowListingVisibility(v)).toBe(v);
  });

  it('[NEW] maps EVERY uninterpretable value to `private`, never to an admitting level', () => {
    // The populations this covers are not hypothetical: `undefined` is the column absent
    // while the manual-apply migration is outstanding, and a string outside the set is a
    // level written by a newer branch than this build.
    for (const bad of [undefined, null, '', 'PUBLIC', 'testers ', 'everyone', 7, {}, []]) {
      expect(narrowListingVisibility(bad)).toBe('private');
    }
  });
});

describe('the audience floor', () => {
  it('[INV] is the level set MINUS `private`, derived rather than re-listed', () => {
    // A hand-written floor tuple would be a closed set that cannot grow with the enum, and
    // the member it would most likely miss is a newly added cohort — which would then
    // narrow to the fail-closed default and lock that cohort out of its own listings.
    for (const f of FLOORS) expect(isListingAudienceFloor(f)).toBe(true);
    expect(isListingAudienceFloor('private')).toBe(false);
    for (const bad of [undefined, null, '', 'mods', 0])
      expect(isListingAudienceFloor(bad)).toBe(false);
  });
});

describe('viewerSeesListingVisibility — the cohort matrix', () => {
  /**
   * 🔴 THE WHOLE MATRIX, ENUMERATED, not a sample. Every (floor, level) pair, with the
   * expected answer written out rather than computed from the ranks — deriving the
   * expectation from the implementation it tests is how a wrong rank map passes.
   */
  const EXPECTED: Record<ListingAudienceFloor, Record<AppListingVisibility, boolean>> = {
    moderators: { private: false, moderators: true, testers: true, public: true },
    testers: { private: false, moderators: false, testers: true, public: true },
    public: { private: false, moderators: false, testers: false, public: true },
  };

  for (const floor of FLOORS) {
    for (const visibility of APP_LISTING_VISIBILITIES) {
      it(`[NEW] floor=${floor} level=${visibility} → ${EXPECTED[floor][visibility]}`, () => {
        expect(viewerSeesListingVisibility(floor, visibility)).toBe(EXPECTED[floor][visibility]);
      });
    }
  }

  it('[INV] `private` admits NOBODY, including a moderator', () => {
    // A moderator reaching a `private` listing does so through a moderation surface, never
    // through a level. If this ever returned true for the `moderators` floor, `private`
    // would silently mean "moderators only" and the enum would have three values.
    for (const floor of FLOORS) expect(viewerSeesListingVisibility(floor, 'private')).toBe(false);
  });

  it('[INV] a wider floor sees a SUPERSET of what a narrower one sees', () => {
    // The subset lattice, asserted as a lattice. This is what makes a single `>=` correct
    // and would fail on any non-monotonic rank map even if every rank stayed distinct.
    const mods = new Set(visibilitiesVisibleTo('moderators'));
    const testers = new Set(visibilitiesVisibleTo('testers'));
    const pub = new Set(visibilitiesVisibleTo('public'));
    for (const v of pub) expect(testers.has(v)).toBe(true);
    for (const v of testers) expect(mods.has(v)).toBe(true);
    // And strictly — each floor must see something the next one does not, or the three
    // cohorts are not distinguishable and the enum is doing nothing.
    expect(mods.size).toBeGreaterThan(testers.size);
    expect(testers.size).toBeGreaterThan(pub.size);
  });

  it('[INV][TAUTOLOGY BY CONSTRUCTION — not cross-layer coverage] visibilitiesVisibleTo is a filter over the predicate', () => {
    // ⚠️ THIS CANNOT FAIL, AND THE NAME SAYS SO. `visibilitiesVisibleTo` is literally
    // `APP_LISTING_VISIBILITIES.filter(v => viewerSeesListingVisibility(floor, v))`, so both
    // sides of the comparison are the same function and no mutation can redden it. It is
    // kept because it DOCUMENTS the construction that makes the data-layer `IN (...)` list
    // and the app-layer predicate one rule rather than two — but it must not be read as
    // evidence that they agree, which is what the old name implied. The claim that CAN fail
    // is the SQL pin in `app-listing-visibility.store-and.test.ts`, which compares the
    // emitted parameter list against the levels.
    for (const floor of FLOORS) {
      const admitted = new Set(visibilitiesVisibleTo(floor));
      for (const v of APP_LISTING_VISIBILITIES) {
        expect(admitted.has(v)).toBe(viewerSeesListingVisibility(floor, v));
      }
    }
  });
});

describe('the eligible-status allowlist', () => {
  it('[INV] is an ALLOWLIST that excludes every negative moderation outcome', () => {
    // 🔴 THE H1 GUARD. A level that reached `removed` or `rejected` would let an owner
    // partially un-take-down their own app — the owner may RUN a delisted app to diagnose
    // it, never make it VISIBLE.
    expect([...VISIBILITY_ELIGIBLE_LISTING_STATUSES]).toEqual(['draft', 'pending', 'approved']);
    expect(isVisibilityEligibleListingStatus('removed')).toBe(false);
    expect(isVisibilityEligibleListingStatus('rejected')).toBe(false);
  });

  it('[INV] every member is a real listing status', () => {
    // `satisfies` pins this at compile time; asserted at runtime too, because a type
    // declaration is not a code path and a stale member would be a silently inert entry.
    for (const s of VISIBILITY_ELIGIBLE_LISTING_STATUSES) {
      expect(APP_LISTING_STATUSES as readonly string[]).toContain(s);
    }
  });

  it('[INV] an UNKNOWN status is refused — fail-closed, not filtered-out', () => {
    // This is the reason the set is a literal allowlist and not
    // `APP_LISTING_STATUSES.filter(not removed/rejected)`: a sixth lifecycle value must be
    // excluded by DEFAULT, so adding one cannot silently grant it an audience.
    for (const bad of ['suspended', 'archived', '', 'APPROVED'])
      expect(isVisibilityEligibleListingStatus(bad)).toBe(false);
  });
});

describe('parseStoredVisibility — `null` is NOT the `private` level', () => {
  it('[INV] an UNSET column stays `null`, never becomes `private`', () => {
    // 🔴 THE DISTINCTION THE WHOLE COLUMN SHAPE RESTS ON. If NULL collapsed to `private`,
    // every future approval would mint a row the store hides — eight scattered writes set
    // `status='approved'` and none of them knows about this column.
    expect(parseStoredVisibility(null)).toBeNull();
    expect(parseStoredVisibility(undefined)).toBeNull();
  });

  it('[NEW] a real stored level passes through', () => {
    for (const v of APP_LISTING_VISIBILITIES) expect(parseStoredVisibility(v)).toBe(v);
  });

  it('[INV] an UNKNOWN stored string fails CLOSED to `private`, not to `null`', () => {
    // The asymmetry is deliberate: absence is a known state, an uninterpretable value is
    // not. A level written by a newer deploy must hide the listing, not fall back to the
    // approved baseline.
    for (const bad of ['PUBLIC', 'everyone', 'moderator', '', 7, {}])
      expect(parseStoredVisibility(bad)).toBe('private');
  });
});

describe('listingVisibleInStore — unset falls back, a set level BINDS', () => {
  it('[INV] an UNSET level on an `approved` listing is visible to every cohort', () => {
    // 🔴 THE REGRESSION THIS EXISTS TO PREVENT. Every existing row, and every row a future
    // approval mints, carries NULL — so if NULL hid an approved listing, the merge would
    // empty the store and each new approval would vanish on go-live.
    for (const floor of FLOORS) {
      expect(listingVisibleInStore({ status: 'approved', visibility: null, floor })).toBe(true);
    }
  });

  it('[INV] an UNSET level on a non-approved listing is visible to NOBODY', () => {
    // The other half of the fallback: NULL means "the pre-feature rule for this status",
    // and that rule hides a draft. NULL can therefore only ever grant the approved
    // baseline — it never admits anything the store does not already show.
    for (const status of ['draft', 'pending']) {
      for (const floor of FLOORS) {
        expect(listingVisibleInStore({ status, visibility: null, floor })).toBe(false);
      }
    }
  });

  it('[NEW] a SET level BINDS on an `approved` listing — an owner can RESTRICT a live one', () => {
    // 🔴 THE CAPABILITY D1 PUTS IN SCOPE, and the one a widen-only predicate silently drops.
    // `private` on an approved listing takes it out of the store entirely (unlisting);
    // `moderators`/`testers` pull it back to that cohort. All DISCOVERY-ONLY — the run route
    // never consults this column — which is why the UI copy must not promise access control.
    for (const floor of FLOORS) {
      for (const visibility of APP_LISTING_VISIBILITIES) {
        expect(
          listingVisibleInStore({ status: 'approved', visibility, floor }),
          `approved @ ${visibility} for ${floor}`
        ).toBe(viewerSeesListingVisibility(floor, visibility));
      }
    }
    // Spelled out for the two cases that carry the capability, so a reader does not have to
    // re-derive them from the rank map.
    expect(
      listingVisibleInStore({ status: 'approved', visibility: 'private', floor: 'public' })
    ).toBe(false);
    expect(
      listingVisibleInStore({ status: 'approved', visibility: 'testers', floor: 'public' })
    ).toBe(false);
    expect(
      listingVisibleInStore({ status: 'approved', visibility: 'testers', floor: 'testers' })
    ).toBe(true);
  });

  it('[NEW] on `draft`/`pending` a set level WIDENS only as far as `moderators`', () => {
    // 🔴 THE REVIEW CEILING, AND THIS CASE PREVIOUSLY ENCODED THE BYPASS IT CLOSES. It
    // asserted that a set level binds unconditionally on an unreviewed listing, i.e. that
    // `draft` + `public` is visible to a `public` floor — which served a listing whose name,
    // URL and content rating no moderator had seen to the anonymous catalog endpoints.
    for (const status of ['draft', 'pending']) {
      for (const floor of FLOORS) {
        for (const visibility of APP_LISTING_VISIBILITIES) {
          const withinCeiling =
            listingVisibilityRank(visibility) <= listingVisibilityRank('moderators');
          expect(
            listingVisibleInStore({ status, visibility, floor }),
            `${status} @ ${visibility} for ${floor}`
          ).toBe(withinCeiling && viewerSeesListingVisibility(floor, visibility));
        }
      }
    }
  });

  it('[NEW] the review ceiling refuses a too-wide level on an UNREVIEWED listing', () => {
    // Spelled out, because this is the bypass and a reader should not have to re-derive it
    // from the rank arithmetic above. A moderator can see an unreviewed listing marked for
    // moderators; nobody sees one marked testers or public, moderators included.
    expect(
      listingVisibleInStore({ status: 'draft', visibility: 'moderators', floor: 'moderators' })
    ).toBe(true);
    for (const floor of FLOORS) {
      for (const tooWide of ['testers', 'public'] as const) {
        expect(
          listingVisibleInStore({ status: 'draft', visibility: tooWide, floor }),
          `draft @ ${tooWide} must be refused for ${floor}`
        ).toBe(false);
      }
    }
    // And the ceiling itself, as data.
    expect(maxVisibilityForStatus('draft')).toBe('moderators');
    expect(maxVisibilityForStatus('pending')).toBe('moderators');
    expect(maxVisibilityForStatus('approved')).toBe('public');
    expect(maxVisibilityForStatus('removed')).toBeNull();
    expect(maxVisibilityForStatus('rejected')).toBeNull();
  });

  it('[INV] a `removed`/`rejected` listing is invisible at EVERY level, set or unset', () => {
    // The status allowlist is checked FIRST, so a row still carrying a level set before it
    // was taken down cannot grant anything. Pinned at the predicate as well as the
    // mutation, because the two are different surfaces and a row can outlive a write gate.
    for (const status of ['removed', 'rejected']) {
      for (const floor of FLOORS) {
        for (const visibility of [...APP_LISTING_VISIBILITIES, null]) {
          expect(
            listingVisibleInStore({ status, visibility, floor }),
            `${status} @ ${visibility} for ${floor}`
          ).toBe(false);
        }
      }
    }
  });
});

/**
 * ⚠️ `listingVisibilityCountsAsUsage` AND ITS FOUR CASES WERE DELETED, NOT MOVED.
 *
 * The predicate had NO production caller, and its docblock asserted two things as handled —
 * that a `moderators`-audience run is invisible in the owner's analytics, and that it pays
 * no author fee. Neither is implemented by this change. A predicate that reads as coverage
 * while providing none is worse than its absence, because it stops the next person looking;
 * the same reasoning removed the unreachable `private` guard above.
 *
 * Where D4 actually stands is recorded in the PR body: for an unreviewed listing the run
 * falls through to the private-run path and inherits the existing exclusion rails unchanged,
 * which is why no new predicate was added. The residual case — a `pending` listing whose
 * backing block is still approved, where the run is an ordinary public run and does count —
 * is stated there as an open item rather than papered over with a predicate nothing calls.
 */
