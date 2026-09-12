import { describe, expect, it } from 'vitest';
import { effectiveBlockScopes } from '~/shared/constants/block-effective-scopes';

/**
 * `effectiveBlockScopes` — the single shared definition of `manifest.scopes ∩ approved_scopes`.
 *
 * This is the module whose expectations are pinned as LITERALS — deriving the helper's OWN
 * expectations from the helper would assert nothing.
 *
 * ⚠️ AN EARLIER REVISION SAID "the consuming sites are pinned against the helper itself". That is
 * true of exactly ONE of them: `user-app-surface.orchestration.test.ts`'s "agrees with
 * effectiveBlockScopes on the same inputs (derived, not copied)". The two router sites in
 * `blocks.router.getInstallConfig.test.ts` are pinned with LITERALS, the same way this file is, and
 * `block-effective-scopes.call-sites.test.ts` asserts import-and-call structure, not values.
 */
describe('effectiveBlockScopes', () => {
  // ── THE TWO DIVERGENCE DIRECTIONS. Both are reachable through
  // `src/pages/api/v1/developer/block-manifests.ts`, which replaces `manifest` + `version` and
  // sets `status: 'pending'` without touching `approved_scopes`.

  it('manifest ⊋ approved (v2 ADDED a scope): returns the approved subset, not the manifest', () => {
    expect(
      effectiveBlockScopes(
        { scopes: ['models:read:self', 'ai:write:budgeted', 'collections:read:private'] },
        ['models:read:self', 'collections:read:private']
      )
    ).toEqual(['models:read:self', 'collections:read:private']);
  });

  // 🔴 THE NEW DEFECT THIS CONSOLIDATION EXISTS TO CLOSE. A v2 manifest that DROPPED a scope
  // leaves `approved_scopes` naming something the current manifest no longer requests. Returning
  // the approval here would re-introduce an over-report in the very direction the change targets.
  it('manifest ⊊ approved (v2 DROPPED a scope): returns the manifest subset, NOT the stale approval', () => {
    expect(
      effectiveBlockScopes({ scopes: ['models:read:self'] }, [
        'models:read:self',
        'ai:write:budgeted',
      ])
    ).toEqual(['models:read:self']);
  });

  // Neither side contains the other — the case that distinguishes a real intersection from
  // "whichever column is shorter".
  it('returns only the overlap when neither side contains the other', () => {
    expect(
      effectiveBlockScopes({ scopes: ['models:read:self', 'buzz:read:self'] }, [
        'buzz:read:self',
        'ai:write:budgeted',
      ])
    ).toEqual(['buzz:read:self']);
  });

  it('returns [] for a disjoint manifest and approval', () => {
    expect(effectiveBlockScopes({ scopes: ['models:read:self'] }, ['ai:write:budgeted'])).toEqual(
      []
    );
  });

  // ── ORDER AND DE-DUPLICATION — observable, because callers render this array as a badge list.

  // 🔴 MANIFEST ORDER, NOT APPROVAL ORDER, AND NOT SORTED. Manifest order is [c, a, b] while
  // approval order and sorted are both [a, b, c] — so the fixture separates manifest order from
  // the other two answers, and only the manifest-order implementation produces the expectation
  // below. ⚠️ It does NOT separate approval order from sorted: those two coincide here, and an
  // earlier revision of this comment claimed "all three answers distinguishable" while showing
  // the coincidence in the same sentence.
  it('preserves MANIFEST order (distinguishable from approval order and from sorted)', () => {
    expect(
      effectiveBlockScopes(
        { scopes: ['collections:read:private', 'ai:write:budgeted', 'buzz:read:self'] },
        ['ai:write:budgeted', 'buzz:read:self', 'collections:read:private']
      )
    ).toEqual(['collections:read:private', 'ai:write:budgeted', 'buzz:read:self']);
  });

  it('de-duplicates a repeated manifest scope, keeping the first occurrence', () => {
    expect(
      effectiveBlockScopes({ scopes: ['buzz:read:self', 'models:read:self', 'buzz:read:self'] }, [
        'models:read:self',
        'buzz:read:self',
      ])
    ).toEqual(['buzz:read:self', 'models:read:self']);
  });

  it('de-duplicates a repeated APPROVED scope without duplicating the output', () => {
    expect(
      effectiveBlockScopes({ scopes: ['buzz:read:self'] }, ['buzz:read:self', 'buzz:read:self'])
    ).toEqual(['buzz:read:self']);
  });

  // ── JSON/DB-BOUNDARY DEFENSIVENESS. These are INVARIANT GUARDS, not regression coverage:
  // Prisma types `approvedScopes` as `string[]`, so nothing in the codebase produces most of
  // these shapes today. They are labelled as such rather than counted. The one that is NOT
  // purely hypothetical is a non-string ELEMENT: the approve paths write
  // `manifest.scopes as string[]` — a bare cast with no per-element check
  // (`publish-request.service.ts`) — so a malformed manifest can land one in the column.
  //
  // 🔴 WHAT THE NEXT TWO CASES DO AND DO NOT PIN. They assert the OUTPUT CONTRACT — a
  // one-sided non-string never reaches the result — and nothing about any particular guard.
  // Measured: with a non-string on one side only, deleting the implementation's `typeof` guard
  // changes NOTHING, because a non-string on one side cannot match a string on the other. They
  // were previously annotated as covering "the approved-side handling"; that was wrong, and an
  // earlier revision's approved-side filter was certified by the first of them without being
  // reachable from it. The guard-level pin is the BOTH-SIDES case below — that is the only
  // fixture in this file that can fail when the implementation's non-string handling is removed.

  it('a one-sided non-string on the APPROVED side never reaches the output', () => {
    expect(
      effectiveBlockScopes({ scopes: ['buzz:read:self', 'models:read:self'] }, [
        null,
        'buzz:read:self',
        42,
        undefined,
        'models:read:self',
      ])
    ).toEqual(['buzz:read:self', 'models:read:self']);
  });

  it('a one-sided non-string on the MANIFEST side never reaches the output', () => {
    expect(
      effectiveBlockScopes({ scopes: [null, 'buzz:read:self', 7, 'models:read:self'] }, [
        'buzz:read:self',
        'models:read:self',
      ])
    ).toEqual(['buzz:read:self', 'models:read:self']);
  });

  // 🔴 THE GUARD-LEVEL PIN, AND THE ONLY NON-STRING CASE HERE THAT CAN FAIL. The SAME
  // non-string sits in BOTH columns, which is what makes it an intersection member and so
  // defeats the "one side filters, the other cannot match" mutual redundancy that made every
  // one-sided fixture blind. Measured against the fixture below:
  //   both guards present / only the approved filter removed / only the loop guard removed
  //     → ['buzz:read:self']          (identical — one-sided fixtures cannot distinguish these)
  //   both removed                    → [42, 'buzz:read:self']   ← the leak this case catches
  // The implementation now carries ONE guard (the loop `typeof`), so this case kills it on its
  // own. A `42` that survived here would reach a `<Badge>` label and a `SCOPE_DESCRIPTIONS`
  // lookup via `BlockScopeList`.
  it('🔴 drops a non-string present in BOTH columns — the case a one-sided fixture cannot see', () => {
    expect(
      effectiveBlockScopes({ scopes: [42, 'buzz:read:self'] }, [42, 'buzz:read:self'])
    ).toEqual(['buzz:read:self']);
  });

  // ── `Array.isArray` ON BOTH SIDES. A non-null SCALAR on purpose: `null` alone cannot
  // distinguish the guard from a weaker `(x ?? []).filter(…)`, because `null ?? []` also yields
  // `[]`, whereas a scalar makes that weaker shape throw `.filter is not a function`.
  //
  // 🔴 BUT A *STRING* SCALAR DOES NOT PIN THE GUARD'S PRESENCE, AND BOTH OF THE NEXT TWO CASES
  // USED TO CLAIM IT DID ("so this pins the guard rather than the nullishness"). Measured by
  // removing one `Array.isArray` clause at a time and running this file plus
  // `user-app-surface.orchestration.test.ts` (79 tests):
  //   · approved-side clause removed → 79 passed, 0 failed. `new Set('buzz:read:self')` builds a
  //     Set of single CHARACTERS, no multi-character scope id matches, and the result is `[]`
  //     either way — so neither string fixture could see it. NOTHING in either suite killed it.
  //   · manifest-side clause removed → 4 failed, and NOT this case: `for (const scope of
  //     'buzz:read:self')` iterates characters that match nothing, again `[]`. The tests that
  //     actually killed it were "returns [] for a missing manifest.scopes, a null manifest, and an
  //     undefined manifest" (iterating `undefined` throws) and three rows in the seam suite.
  // So the two string cases pin the OUTPUT CONTRACT for a realistic JSON-column mishap, and they
  // distinguish the guard from the weaker `(x ?? []).filter(…)` shape. They do NOT pin the clause
  // against deletion. The NUMBER case below is what does, and it is why it was added.
  it('returns [] when approvedScopes is a non-array scalar, rather than throwing', () => {
    expect(
      effectiveBlockScopes(
        { scopes: ['buzz:read:self', 'models:read:self'] },
        'buzz:read:self' as unknown
      )
    ).toEqual([]);
  });

  it('returns [] when manifest.scopes is a non-array scalar, rather than throwing', () => {
    expect(effectiveBlockScopes({ scopes: 'buzz:read:self' }, ['buzz:read:self'])).toEqual([]);
  });

  // 🔴 THE KILLING FIXTURE FOR THE APPROVED-SIDE `Array.isArray` CLAUSE — a NON-ITERABLE scalar.
  // A number is not iterable, so with the clause gone `new Set(42)` throws
  // `TypeError: number 42 is not iterable` instead of returning `[]`. That is the one shape a
  // string cannot produce, which is exactly why every string fixture left the clause alive.
  // Asserted on the approved side alone so a failure attributes to THAT clause: the manifest-side
  // clause is already killed by the missing/null/undefined-manifest case above.
  it('🔴 returns [] for a NON-ITERABLE approvedScopes — the only shape that kills its isArray guard', () => {
    expect(effectiveBlockScopes({ scopes: ['buzz:read:self'] }, 42 as unknown)).toEqual([]);
  });

  it('returns [] for a missing manifest.scopes, a null manifest, and an undefined manifest', () => {
    expect(effectiveBlockScopes({}, ['buzz:read:self'])).toEqual([]);
    expect(effectiveBlockScopes(null, ['buzz:read:self'])).toEqual([]);
    expect(effectiveBlockScopes(undefined, ['buzz:read:self'])).toEqual([]);
  });

  it('returns [] for an empty approval even when the manifest declares scopes', () => {
    expect(effectiveBlockScopes({ scopes: ['models:read:self'] }, [])).toEqual([]);
  });

  it('returns [] for a null/undefined approval even when the manifest declares scopes', () => {
    expect(effectiveBlockScopes({ scopes: ['models:read:self'] }, null)).toEqual([]);
    expect(effectiveBlockScopes({ scopes: ['models:read:self'] }, undefined)).toEqual([]);
  });

  // Not filtered to the known scope vocabulary — none of the call sites did that, and the mint
  // applies its own `isKnownBlockScope` filter. An unknown id that IS in both columns passes
  // through, which is what keeps this a pure consolidation rather than a behaviour change.
  it('does NOT filter to the known scope vocabulary', () => {
    expect(effectiveBlockScopes({ scopes: ['not:a:real:scope'] }, ['not:a:real:scope'])).toEqual([
      'not:a:real:scope',
    ]);
  });

  it('never returns the input arrays by reference', () => {
    const manifestScopes = ['buzz:read:self'];
    const approved = ['buzz:read:self'];
    const out = effectiveBlockScopes({ scopes: manifestScopes }, approved);
    expect(out).not.toBe(manifestScopes);
    expect(out).not.toBe(approved);
  });
});
