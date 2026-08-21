import { describe, expect, it } from 'vitest';
import {
  scopeAdmitsListingKind,
  STORE_LISTING_KINDS,
  STORE_VISIBILITY_SCOPES,
  storeScopeRank,
  type StoreListingKind,
  type StoreVisibilityScope,
} from '~/shared/utils/store-visibility-scope';

/**
 * `scopeAdmitsListingKind` — the ONE scope→kind rule.
 *
 * It exists as a shared export because THREE surfaces have to agree on it: the
 * review WRITE gate (server), the review affordance (client), and — in its Prisma
 * relation-filter form — the reviews READ. They previously did not: the read path
 * branched on the resolved scope while the write gate branched on a FLAG, so the
 * `app-listings-public-external` cohort saw a review button on an offsite listing
 * and was refused on submit.
 *
 * The full 3×2 matrix is enumerated below rather than sampled — the set is closed
 * and tiny, so there is no reason to generalise from a subset.
 */

const ALL_SCOPES = STORE_VISIBILITY_SCOPES as readonly StoreVisibilityScope[];
const ALL_KINDS = STORE_LISTING_KINDS as readonly StoreListingKind[];

describe('scopeAdmitsListingKind — the complete matrix', () => {
  it.each([
    ['full', 'onsite', true],
    ['full', 'offsite', true],
    ['public-external', 'onsite', false],
    ['public-external', 'offsite', true],
    ['none', 'onsite', false],
    ['none', 'offsite', false],
  ] as [StoreVisibilityScope, StoreListingKind, boolean][])(
    '%s admits %s → %s',
    (scope, kind, expected) => {
      expect(scopeAdmitsListingKind(scope, kind)).toBe(expected);
    }
  );

  it('covers every (scope, kind) pair in the closed sets — no case is unenumerated', () => {
    const pairs = ALL_SCOPES.flatMap((s) => ALL_KINDS.map((k) => [s, k]));
    expect(pairs).toHaveLength(6);
    // And every one returns an actual boolean — a scope falling off the switch would
    // yield `undefined`, which is falsy and would therefore hide inside a `!` guard
    // at every call site rather than failing.
    for (const [s, k] of pairs as [StoreVisibilityScope, StoreListingKind][]) {
      expect(typeof scopeAdmitsListingKind(s, k), `${s}/${k}`).toBe('boolean');
    }
  });
});

describe('the properties call sites actually rely on', () => {
  it('🔴 `full` is a strict SUPERSET of `public-external` — it admits everything the latter does, and more', () => {
    for (const k of ALL_KINDS) {
      if (scopeAdmitsListingKind('public-external', k)) {
        expect(scopeAdmitsListingKind('full', k), k).toBe(true);
      }
    }
    // "and more" — asserted, not assumed, so a `public-external` that silently
    // widened to admit onsite would break this rather than pass the superset check.
    expect(scopeAdmitsListingKind('full', 'onsite')).toBe(true);
    expect(scopeAdmitsListingKind('public-external', 'onsite')).toBe(false);
  });

  it('🔴 `none` admits NOTHING — the empty set, so the write gate can reject it wholesale', () => {
    for (const k of ALL_KINDS) expect(scopeAdmitsListingKind('none', k), k).toBe(false);
  });

  it('MONOTONE in scope breadth: a wider scope never admits FEWER kinds', () => {
    // This is the property that makes it safe to lift a viewer's scope. Pinned
    // against the rank map so the two orderings cannot drift apart.
    for (const a of ALL_SCOPES)
      for (const b of ALL_SCOPES) {
        if (storeScopeRank(a) >= storeScopeRank(b)) {
          for (const k of ALL_KINDS) {
            if (scopeAdmitsListingKind(b, k)) {
              expect(scopeAdmitsListingKind(a, k), `${a} ⊇ ${b} @ ${k}`).toBe(true);
            }
          }
        }
      }
  });

  it('the rule is about the KIND, not about which flag granted the scope', () => {
    // `public-external` is reached via `app-listings-public-external`; `full` via
    // `app-listings` OR `app-blocks-enabled`. The function takes neither — it takes
    // the resolved scope, which is the whole correction. A signature that accepted a
    // flag name could not express "offsite yes, onsite no" at all.
    expect(scopeAdmitsListingKind.length).toBe(2);
  });
});
