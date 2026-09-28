import { describe, expect, test } from 'vitest';
import {
  buildScopeConsentRows,
  FIXED_SCOPE_NOTES,
  fixedScopeNote,
} from '~/components/Apps/scopeConsentRows';
import {
  CONSENT_SPEND_SCOPE,
  consentExemptScopeList,
} from '~/server/services/blocks/scope-grant.service';
import { BLOCK_SPEND_SCOPE, isKnownBlockScope } from '~/shared/constants/block-scope.constants';

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

  /**
   * 🔴 `undefined` AND `[]` MUST NOT AGREE. This is the defect the correctness-review lane found:
   * the caller coalesced a missing `revokableScopes` to `[]`, which made every row `fixed` — so a
   * genuinely withdrawable scope rendered a sentence asserting it was granted by platform policy
   * and could not be withdrawn. Fail-closed for the action, fail-OPEN for the copy.
   *
   * The pair is asserted TOGETHER in one test on purpose: the whole claim is that the two inputs
   * produce DIFFERENT states, and two separate tests could both pass while the distinction was
   * lost (each asserting its own expected value against a function that ignored the difference is
   * impossible, but a later edit splitting them invites exactly that).
   */
  test('🔴 ABSENT revokableScopes yields `unknown`; EMPTY yields `fixed`', () => {
    const scopes = ['ai:write:budgeted'];
    expect(
      buildScopeConsentRows({ scopes, revokedScopes: [], revokableScopes: undefined })
    ).toEqual([{ scope: 'ai:write:budgeted', state: 'unknown' }]);
    expect(buildScopeConsentRows({ scopes, revokedScopes: [], revokableScopes: [] })).toEqual([
      { scope: 'ai:write:budgeted', state: 'fixed' },
    ]);
  });

  test('🔴 a REVOKED scope stays `revoked` even on a payload with no revokableScopes', () => {
    // The `unknown` test sits after the `revoked` test deliberately: a suppression the server DID
    // report is a fact we can still state, and hiding a known withdrawal is the one regression this
    // surface must never have. If the order flipped, a pre-phase-2 payload that still carried
    // `revokedScopes` would silently stop marking them.
    expect(
      buildScopeConsentRows({
        scopes: ['posts:write:self'],
        revokedScopes: ['posts:write:self'],
        revokableScopes: undefined,
      })
    ).toEqual([{ scope: 'posts:write:self', state: 'revoked' }]);
  });
});

/**
 * 🔴 THE CLIENT AND SERVER SPEND-SCOPE CONSTANTS MUST BE THE SAME STRING, AND THIS IS THE ONLY
 * PLACE THAT CAN SAY SO. `BLOCK_SPEND_SCOPE` lives in client-safe shared constants;
 * `CONSENT_SPEND_SCOPE` lives in `scope-grant.service.ts`, which imports Prisma and therefore
 * cannot be reached from any browser module — so the two cannot be collapsed into one declaration
 * from the client side, and phase 3 was scoped out of `src/server/**`. This node-tier test is the
 * one context that imports BOTH.
 *
 * ⚠️ IT IS A SEAM GUARD, NOT COVERAGE OF EITHER CONSTANT. The remaining duplication is deliberate
 * and recorded on `BLOCK_SPEND_SCOPE`: whoever next edits that service should make
 * `CONSENT_SPEND_SCOPE` a re-export, at which point this test becomes trivially true and can go.
 * Until then it is the only thing standing between a vocabulary rename and a spend path that
 * silently stops being capped — the grant modal decides whether to OFFER a budget field, the editor
 * decides what to SEND, and the revoke dialog claims withdrawing this scope CLEARS the budget.
 */
describe('the spend scope is one string on both sides of the client/server line', () => {
  test('🔴 BLOCK_SPEND_SCOPE === CONSENT_SPEND_SCOPE', () => {
    expect(BLOCK_SPEND_SCOPE).toBe(CONSENT_SPEND_SCOPE);
  });

  test('…and it is a real, consent-GATED scope — not exempt, not retired', () => {
    // Three properties the whole budget/revoke story rests on. If the spend scope were exempt,
    // `blocks.revokeScopes` would refuse it and the confirm dialog's budget sentence would describe
    // an action that cannot happen; if it were unknown, the router would reject it outright.
    expect(isKnownBlockScope(BLOCK_SPEND_SCOPE)).toBe(true);
    expect(consentExemptScopeList()).not.toContain(BLOCK_SPEND_SCOPE);
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

  /**
   * 🔴 AN UNKNOWN SCOPE GETS ITS OWN SENTENCE, NOT THE EXEMPT ONE — and the first version of this
   * test asserted the opposite, which is how the bug hid. It required the unknown note to match
   * `/can't be withdrawn/i` like the exempt notes, i.e. it ASSERTED the shared generic that the
   * correctness-review lane then showed was false: "granted by platform policy … bounded by
   * server-side checks on every request" is a claim about a privilege the app HOLDS, and a scope
   * retired from the registry is granted by nothing and enforced by nothing.
   *
   * `block:settings:read`/`write` and `media:read:owned` are the real population — retired from the
   * registry yet still present in some apps' `manifest.scopes` AND `approved_scopes`, so they reach
   * the rendered list. Using one of them rather than an invented id keeps this test pointed at the
   * population that exists.
   */
  test('🔴 a RETIRED scope says it grants nothing — NOT the exempt "platform policy" note', () => {
    const retired = 'block:settings:read';
    // A precondition, not decoration: if this ever becomes a known scope the test below is about
    // a different branch and must be re-pointed.
    expect(isKnownBlockScope(retired), `${retired} is in the registry again`).toBe(false);
    const note = fixedScopeNote(retired);
    expect(note).toBeTruthy();
    // It must NOT claim the app holds a platform-granted privilege over the account.
    expect(note).not.toMatch(/platform policy/i);
    expect(note).not.toMatch(/server-side checks on every request/i);
    // It must say the honest thing instead: there is nothing there.
    expect(note).toMatch(/no longer in use/i);
    expect(note).toMatch(/nothing to withdraw/i);
    // …and it is not silently one of the exempt sentences.
    for (const exemptNote of Object.values(FIXED_SCOPE_NOTES)) {
      expect(note).not.toBe(exemptNote);
    }
  });

  test('a KNOWN scope with no specific note still falls back to the exempt generic', () => {
    // The third branch, and the drift direction that DOES degrade safely: the exempt set growing
    // server-side without this map being updated. `isKnownBlockScope` must be true here or the
    // test is measuring the retired branch above instead.
    const known = 'posts:write:self';
    expect(isKnownBlockScope(known)).toBe(true);
    expect(
      FIXED_SCOPE_NOTES[known],
      'this scope gained a specific note — pick another'
    ).toBeUndefined();
    expect(fixedScopeNote(known)).toMatch(/granted by platform policy/i);
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
