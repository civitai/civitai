import { describe, expect, test } from 'vitest';
import {
  buildScopeConsentRows,
  FIXED_SCOPE_NOTES,
  fixedScopeNote,
} from '~/components/Apps/scopeConsentRows';
import { consentExemptScopeList } from '~/server/services/blocks/scope-grant.service';

/**
 * PHASE 3 — the pure half: which rows exist and what state each is in.
 *
 * Node tier deliberately. Every claim here is about a function with no DOM, and the one guard that
 * matters most — that all seven consent-exempt scopes carry a specific note — needs the SERVER's
 * exempt list to be the population, which a browser-tier file cannot import.
 */
describe('buildScopeConsentRows', () => {
  test('a scope in revokableScopes gets `revokable`, one outside it gets `fixed`', () => {
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted', 'apps:storage:read'],
      revokedScopes: [],
      revokableScopes: ['ai:write:budgeted'],
    });
    expect(rows).toEqual([
      { scope: 'ai:write:budgeted', state: 'revokable' },
      { scope: 'apps:storage:read', state: 'fixed' },
    ]);
  });

  test('🔴 `revoked` BEATS `revokable` — the two server sets overlap by construction', () => {
    // `revokableScopes` is computed from the DISPLAYED set with no reference to what has been
    // withdrawn, so a just-revoked scope is in BOTH arrays. That is correct server-side (a
    // re-consent then a second revoke must both be possible) and wrong for a row, which has one
    // state. If the precedence flipped, a withdrawn permission would render a live "Remove"
    // button and the revoked marker would never appear at all.
    const rows = buildScopeConsentRows({
      scopes: ['posts:write:self'],
      revokedScopes: ['posts:write:self'],
      revokableScopes: ['posts:write:self'],
    });
    expect(rows).toEqual([{ scope: 'posts:write:self', state: 'revoked' }]);
  });

  test('🔴 a revoked scope the manifest no longer declares is still a row', () => {
    // The withdrawal must survive the app dropping that scope in a later version — otherwise the
    // permissions surface FORGETS what the viewer withdrew, which is the one thing it must never
    // do. `scopes` is the app-side intersection and cannot contain it.
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted'],
      revokedScopes: ['collections:read:private'],
      revokableScopes: ['ai:write:budgeted'],
    });
    expect(rows).toEqual([
      { scope: 'ai:write:budgeted', state: 'revokable' },
      { scope: 'collections:read:private', state: 'revoked' },
    ]);
  });

  test('the declared set keeps its server order; only the appended tail is sorted', () => {
    // Order matters beyond tidiness: the phase-1 geometry arms read the gap from the FIRST
    // fixture scope's description DOWN to the SECOND scope's id, so re-ordering the declared set
    // would move what those arms measure.
    const rows = buildScopeConsentRows({
      scopes: ['zzz:read:self', 'aaa:read:self'],
      revokedScopes: ['zeta:write:self', 'alpha:write:self'],
      revokableScopes: ['zzz:read:self', 'aaa:read:self'],
    });
    expect(rows.map((r) => r.scope)).toEqual([
      'zzz:read:self',
      'aaa:read:self',
      'alpha:write:self',
      'zeta:write:self',
    ]);
  });

  test('a revoked scope that IS declared is not duplicated into the tail', () => {
    const rows = buildScopeConsentRows({
      scopes: ['posts:write:self'],
      revokedScopes: ['posts:write:self'],
      revokableScopes: [],
    });
    expect(rows).toHaveLength(1);
  });

  test('does not mutate the arrays it is handed', () => {
    // `revokedScopes` comes straight off react-query's cache; an in-place `.sort()` would reorder
    // a shared array under every other reader of that query.
    const revokedScopes = ['zeta:write:self', 'alpha:write:self'];
    buildScopeConsentRows({ scopes: [], revokedScopes, revokableScopes: [] });
    expect(revokedScopes).toEqual(['zeta:write:self', 'alpha:write:self']);
  });

  test('an empty grant produces no rows', () => {
    expect(buildScopeConsentRows({ scopes: [], revokedScopes: [], revokableScopes: [] })).toEqual(
      []
    );
  });
});

describe('fixedScopeNote', () => {
  /**
   * 🔴 THE POPULATION IS THE SERVER'S EXEMPT LIST, NOT A LITERAL SEVEN RETYPED HERE. A retyped
   * list passes forever after the real set changes, which is the exact drift this whole arc keeps
   * paying for. `consentExemptScopeList()` is a COPY of the set `partitionByConsent` consults.
   */
  test('every consent-exempt scope has a SPECIFIC note, not the generic fallback', () => {
    const exempt = consentExemptScopeList();
    // A positive control on the import: an empty population would make the loop below vacuous
    // and it would report success having checked nothing.
    expect(exempt.length, 'the exempt list is empty — this test checks nothing').toBe(7);
    const missing = exempt.filter((scope) => !(scope in FIXED_SCOPE_NOTES));
    expect(missing, 'exempt scopes with no specific note').toEqual([]);
    for (const scope of exempt) {
      expect(fixedScopeNote(scope), scope).toBe(FIXED_SCOPE_NOTES[scope]);
      // Each note has to say the thing the row exists to say. Asserted as a property of the
      // string rather than by pinning seven sentences: this is a "does it answer the question"
      // check, and the wording is reviewed prose.
      expect(fixedScopeNote(scope), scope).toMatch(/can't be withdrawn/i);
    }
  });

  test('🔴 an UNKNOWN scope gets the generic note, never `undefined`', () => {
    // The `fixed` state's other population. A bare `FIXED_SCOPE_NOTES[scope]` read would render
    // nothing here — a row with no control and no explanation, which is the silence this phase
    // exists to remove.
    const note = fixedScopeNote('some:future:scope');
    expect(note).toBeTruthy();
    expect(note).toMatch(/can't be withdrawn/i);
    expect(note).not.toBe(FIXED_SCOPE_NOTES['apps:storage:read']);
  });

  test('no note points the viewer at the Installs tab', () => {
    // An exemption is applied at the MINT, before the grant is consulted, so an uninstall does
    // not stop an exempt scope reaching `claims.scopes`. Saying otherwise would repeat the exact
    // false instruction the /apps/activity copy was corrected for.
    for (const [scope, note] of Object.entries(FIXED_SCOPE_NOTES)) {
      expect(note.toLowerCase(), scope).not.toMatch(/uninstall|installs tab/);
    }
  });
});
