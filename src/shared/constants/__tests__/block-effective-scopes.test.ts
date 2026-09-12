import { describe, expect, it } from 'vitest';
import { effectiveBlockScopes } from '~/shared/constants/block-effective-scopes';

/**
 * `effectiveBlockScopes` — the single shared definition of `manifest.scopes ∩ approved_scopes`.
 *
 * This is the module whose expectations are pinned as LITERALS. The consuming sites are pinned
 * against the helper itself (see `block-effective-scopes.call-sites.test.ts` and the
 * helper-derived assertions in `user-app-surface.orchestration.test.ts`), which is the right split
 * for a consolidation: literals here, identity there. Deriving the helper's OWN expectations from
 * the helper would assert nothing.
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

  // 🔴 MANIFEST ORDER, NOT APPROVAL ORDER, AND NOT SORTED. The fixture makes all three answers
  // distinguishable: manifest order is [c, a, b], approval order is [a, b, c], sorted would be
  // [a, b, c] as well. Only the manifest-order implementation produces the expectation below.
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

  it('drops non-string elements on the APPROVED side', () => {
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

  it('drops non-string elements on the MANIFEST side', () => {
    expect(
      effectiveBlockScopes({ scopes: [null, 'buzz:read:self', 7, 'models:read:self'] }, [
        'buzz:read:self',
        'models:read:self',
      ])
    ).toEqual(['buzz:read:self', 'models:read:self']);
  });

  // A non-null SCALAR on purpose: `null` alone cannot distinguish the `Array.isArray` guard from a
  // weaker `(x ?? []).filter(…)`, because `null ?? []` also yields `[]`. A bare string is the
  // realistic JSON-column mishap AND it makes the weaker shape throw
  // `.filter is not a function`, so this pins the guard rather than the nullishness.
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
