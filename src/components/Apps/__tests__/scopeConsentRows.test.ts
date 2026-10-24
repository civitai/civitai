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
 * matters most — that EVERY consent-exempt scope carries a specific note — needs the SERVER's
 * exempt list to be the population, which a browser-tier file cannot import.
 */
describe('buildScopeConsentRows', () => {
  test('a scope in revokableScopes gets `revokable`, one outside it gets `fixed`', () => {
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted', 'apps:storage:read'],
      revokedScopes: [],
      revokableScopes: ['ai:write:budgeted'],
      grantedScopes: ['ai:write:budgeted'],
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
      grantedScopes: [],
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
      grantedScopes: ['ai:write:budgeted'],
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
      grantedScopes: ['zzz:read:self', 'aaa:read:self'],
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
      grantedScopes: [],
    });
    expect(rows).toHaveLength(1);
  });

  test('does not mutate the arrays it is handed', () => {
    // `revokedScopes` comes straight off react-query's cache; an in-place `.sort()` would reorder
    // a shared array under every other reader of that query.
    const revokedScopes = ['zeta:write:self', 'alpha:write:self'];
    buildScopeConsentRows({ scopes: [], revokedScopes, revokableScopes: [], grantedScopes: [] });
    expect(revokedScopes).toEqual(['zeta:write:self', 'alpha:write:self']);
  });

  test('an empty grant produces no rows', () => {
    expect(
      buildScopeConsentRows({
        scopes: [],
        revokedScopes: [],
        revokableScopes: [],
        grantedScopes: [],
      })
    ).toEqual([]);
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
      buildScopeConsentRows({
        scopes,
        revokedScopes: [],
        revokableScopes: undefined,
        grantedScopes: undefined,
      })
    ).toEqual([{ scope: 'ai:write:budgeted', state: 'unknown' }]);
    expect(
      buildScopeConsentRows({
        scopes,
        revokedScopes: [],
        revokableScopes: [],
        grantedScopes: [],
      })
    ).toEqual([{ scope: 'ai:write:budgeted', state: 'fixed' }]);
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
        grantedScopes: undefined,
      })
    ).toEqual([{ scope: 'posts:write:self', state: 'revoked' }]);
  });

  /**
   * 🔴 A DECLARED-BUT-NEVER-GRANTED SCOPE IS `not-granted`, NOT `revokable`, AND THAT WAS A LIVE
   * BUTTON ON A PERMISSION NEVER GIVEN. `revokableScopes` is computed server-side from the
   * APP-SIDE set — `consentGatedScopes(displayedScopes).filter(isKnownBlockScope)` — with no
   * reference to what the viewer granted, and this function took no granted set at all. So an app
   * declaring `posts:write:self` rendered a Remove control for a viewer who never consented, and
   * the click wrote a durable suppression: not a no-op, because `revoked_scopes` survives every
   * later install and therefore makes a FUTURE consent prompt's grant inert.
   * `blocks.revokeScopes` now refuses that call, so the control would be broken rather than merely
   * confusing.
   *
   * MUTATION THAT MUST KILL IT: return `'revokable'` for the `!granted.has(scope)` arm (i.e. drop
   * the granted-set split).
   */
  test('🔴 a declared scope the viewer never granted is `not-granted`, not `revokable`', () => {
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted', 'posts:write:self'],
      revokedScopes: [],
      // The server offers BOTH as consent-gated — that is the app's set, not the viewer's.
      revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
      // …and the viewer only ever agreed to one of them.
      grantedScopes: ['ai:write:budgeted'],
    });
    expect(
      rows,
      'a permission the viewer never granted was offered a Remove control the server now refuses'
    ).toEqual([
      { scope: 'ai:write:budgeted', state: 'revokable' },
      { scope: 'posts:write:self', state: 'not-granted' },
    ]);
  });

  /**
   * 🔴 A SCOPE IN THE **GRANTED** SET BUT NOT IN `revokableScopes` IS `fixed`, AND THIS IS THE ONE
   * INPUT THAT MAKES "revokable-membership is tested FIRST" OBSERVABLE.
   *
   * ⚠️ IT EXISTS BECAUSE THE ARM BELOW CANNOT SEE THAT ORDERING, MEASURED. The reorder has TWO
   * natural spellings and the per-exempt-scope arm kills only one of them:
   *   - spelling B, `!granted.has(scope) ? 'not-granted' : …` — dies on every exempt fixture.
   *   - spelling A, `granted.has(scope) ? 'revokable' : !revokable.has(scope) ? 'fixed' : …` —
   *     measured **SURVIVING the whole segment**: 40 unit + 91 component + 85 geometry, all green.
   * It survives because every `grantedScopes` fixture in this file, in
   * `ScopeRevoke.browser.test.tsx` and in `AppsWideLayout.geometry.test.tsx` is a SUBSET of its
   * arm's `revokableScopes`, so the `granted ∖ revokable` region was never built. Reported by the
   * test-review lane and re-measured rather than taken on its word.
   *
   * 🔴 AND THE REGION IS REACHABLE, WITH THE BLAST RADIUS ALREADY DOCUMENTED ELSEWHERE.
   * `revokableScopes` is registry-filtered server-side (`.filter(isKnownBlockScope)`) while
   * `granted_scopes` is NOT — `BlockRegistry.recordInstallConsent` writes
   * `consentGatedScopes(effective)` with no registry filter. So a scope RETIRED from the
   * vocabulary but still sitting in an app's `manifest.scopes` AND `approved_scopes` is granted,
   * displayed, and excluded from `revokableScopes`. Under spelling A that row gets a live Remove
   * button — and `blocks.revokeScopes` refuses an unknown string ALL-OR-NOTHING, so pressing it
   * fails the whole call and the viewer can revoke nothing else on that app either. That is the
   * exact hazard `listMyScopeGrants`' `revokableScopes` docblock was written for.
   *
   * MUTATION THAT MUST KILL IT: either spelling of the reorder. This arm kills spelling A; the
   * exempt arm below kills spelling B.
   */
  test('🔴 a GRANTED scope outside revokableScopes is `fixed` — retired-from-registry', () => {
    const RETIRED = 'block:settings:write';
    // The precondition, asserted rather than assumed: this really is outside the vocabulary, which
    // is why the server excludes it from `revokableScopes` while the grant column still holds it.
    expect(isKnownBlockScope(RETIRED), 'the fixture scope re-entered the registry').toBe(false);
    const rows = buildScopeConsentRows({
      scopes: [RETIRED],
      revokedScopes: [],
      // Registry-filtered server-side, so the retired scope is absent…
      revokableScopes: [],
      // …but `granted_scopes` is not registry-filtered, so it is present.
      grantedScopes: [RETIRED],
    });
    expect(
      rows,
      'a registry-retired scope the viewer granted was offered a Remove control. ' +
        '`blocks.revokeScopes` refuses unknown strings all-or-nothing, so pressing it fails the ' +
        'whole call and the viewer can revoke NOTHING on that app.'
    ).toEqual([{ scope: RETIRED, state: 'fixed' }]);
  });

  /**
   * 🔴 THE EXEMPT SCOPES KEEP `fixed`. No grant is ever recorded for a `CONSENT_EXEMPT_SCOPES`
   * member — `partitionByConsent` signs it on the exempt test alone, before it looks at the grant —
   * so every member is ALWAYS outside `grantedScopes`. Relabelling them `not-granted` would drop
   * their specific `FIXED_SCOPE_NOTES` sentences, the only place a viewer is told what governs the
   * permission instead of their consent.
   *
   * ⚠️ WHAT THIS ARM ACTUALLY CHECKS IS NARROWER THAN ITS FIRST WORDING CLAIMED, AND THE WORDING IS
   * CORRECTED RATHER THAN THE ARM. It said "this is the ordering the new state could have broken",
   * and it cannot see that: the ladder reaches `fixed` at `!revokable.has(scope)` and never consults
   * `granted`, so `grantedScopes: []` here is INERT to the verdict — measured, setting it to
   * `[scope]` (which contradicts this arm's own message) leaves every case green. The ordering claim
   * belongs to the retired-scope arm above. What these cases pin is that a scope in NEITHER server
   * set is `fixed`, for the real exempt population.
   *
   * ⚠️ AND THE ENUMERATION ADDS NO MUTANT KILLS OVER ONE ARM: `buildScopeConsentRows` cannot tell the
   * scopes apart — it branches only on set membership and row order. The enumeration is kept
   * because it is the real server list and would go red if the exempt set were emptied, not because
   * N inputs cover more than one. (The per-scope NOTES genuinely differ, and that is what the
   * `fixedScopeNote` describe below enumerates for.)
   */
  test.each(consentExemptScopeList())('🔴 %s is in neither server set, so `fixed`', (scope) => {
    const rows = buildScopeConsentRows({
      scopes: [scope],
      revokedScopes: [],
      // What the server really sends for an exempt scope: excluded from `revokableScopes`…
      revokableScopes: [],
      // …and absent from the granted set, because none was ever recorded.
      grantedScopes: [],
    });
    expect(
      rows,
      `${scope} is consent-exempt and in neither server set; labelling it \`not-granted\` would ` +
        'drop its FIXED_SCOPE_NOTES sentence, the only place the viewer learns what governs it ' +
        'instead of their consent'
    ).toEqual([{ scope, state: 'fixed' }]);
  });

  /**
   * 🔴 `revoked` STILL BEATS `not-granted`. After a successful revoke the scope leaves
   * `grantedScopes` (the server subtracts `revoked_scopes`) while STAYING in `revokableScopes`. If
   * the granted-set test ran before the revoked test, every withdrawn permission would render
   * "Not granted yet" instead of the "Removed / you withdrew this" marker — the surface forgetting
   * what the viewer withdrew, which is the one regression it must never have.
   *
   * MUTATION THAT MUST KILL IT: move the `granted.has(scope)` split above the `revoked.has(scope)`
   * test.
   */
  test('🔴 a revoked scope is `revoked`, not `not-granted`, once it leaves the granted set', () => {
    const rows = buildScopeConsentRows({
      scopes: ['posts:write:self'],
      revokedScopes: ['posts:write:self'],
      revokableScopes: ['posts:write:self'],
      // Exactly what the server sends after the revoke: subtracted out of the live granted set.
      grantedScopes: [],
    });
    expect(
      rows,
      'a withdrawn permission rendered as never-granted, so the page forgot the withdrawal'
    ).toEqual([{ scope: 'posts:write:self', state: 'revoked' }]);
  });

  /**
   * 🔴 THE REAL PRODUCTION SHAPE, AND THE SENTENCE IT USED TO PRODUCE WAS FALSE ABOUT 10 REAL
   * USERS. Measured on the production primary 2026-09-28: `revoked_scopes` and
   * `revoked_scopes_at` do NOT exist in the `civitai` database, and **21 of 41** grant rows
   * (51%, across 10 users and 11 apps, every one stamped 2026-09-17) carry
   * `revoked_at IS NOT NULL AND array_length(granted_scopes,1) > 0` — the
   * `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` shape, whose `UPDATE` sets
   * `revoked_at = now()` and deliberately leaves `granted_scopes` intact to keep the audit trail.
   *
   * So the surface reports `grantedScopes: []` (`liveGrantedScopes` collapses on `revoked_at`)
   * while `revokableScopes` is the app's full consent-gated set, and `revokedScopes` is `[]`
   * because the column cannot be read. Every gated row therefore landed in `not-granted` and
   * rendered "Not granted yet — the app will ask if it needs this." for permissions those viewers
   * DID grant. The control was right and the sentence was a lie.
   *
   * 🔴 `withheld` IS A DISTINCT STATE, NOT A REUSE, because none of the four existing ones is
   * true here: `revokable` would offer a control the server refuses; `revoked` says the viewer
   * withdrew it (an operator did); `fixed` says the platform granted it and enforces it
   * server-side; `not-granted` says they never gave it. `unknown` would be silence about a fact
   * we know.
   *
   * MUTATION THAT MUST KILL IT: drop the `withheld` arm from `buildScopeConsentRows`' ladder, or
   * stop threading `grantWithheldAt`.
   */
  test('🔴 PRODUCTION SHAPE: a withheld whole grant is `withheld`, not `not-granted`', () => {
    const rows = buildScopeConsentRows({
      // An app declaring three gated scopes…
      scopes: ['ai:write:budgeted', 'posts:write:self'],
      // …no per-scope suppression readable, because the column does not exist…
      revokedScopes: [],
      revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
      // …an EMPTY live granted set, because `revoked_at` collapses it…
      grantedScopes: [],
      // …and the whole-grant flag, which IS on the production schema today.
      grantWithheldAt: new Date('2026-09-17T12:00:00Z'),
    });
    expect(
      rows,
      'a withheld whole grant rendered as never-granted. 21 of 41 production grant rows are this ' +
        'shape, across 10 users: the viewer DID grant these and an operator reset them, so ' +
        '"Not granted yet" is false about their own consent history.'
    ).toEqual([
      { scope: 'ai:write:budgeted', state: 'withheld' },
      { scope: 'posts:write:self', state: 'withheld' },
    ]);
  });

  /**
   * 🔴 `fixed` STILL WINS OVER `withheld`, AND THIS IS THE ORDERING THE NEW STATE COULD BREAK.
   * `revoked_at` does NOT withhold a `CONSENT_EXEMPT_SCOPES` member: `partitionByConsent` signs an
   * exempt scope on the exempt test ALONE, before it ever consults the grant, so such a scope is
   * still live on a withheld row and its own server-side gates are still what govern it. Labelling
   * it `withheld` would tell the viewer a permission is on hold when the app can use it right now —
   * false in the dangerous direction on a consent surface.
   *
   * MUTATION THAT MUST KILL IT: move the `withheld` test above the `!revokable.has(scope)` test.
   */
  test('🔴 an EXEMPT scope on a withheld row stays `fixed` — exemption survives revoked_at', () => {
    const rows = buildScopeConsentRows({
      scopes: ['models:read:self', 'ai:write:budgeted'],
      revokedScopes: [],
      // Exempt scopes are excluded from `revokableScopes` server-side; the gated one is not.
      revokableScopes: ['ai:write:budgeted'],
      grantedScopes: [],
      grantWithheldAt: new Date('2026-09-17T12:00:00Z'),
    });
    expect(
      rows,
      'an exempt scope was reported as on hold. `revoked_at` cannot withhold it — the mint signs ' +
        'it on the exempt test alone — so the app can still use it and the note would be false.'
    ).toEqual([
      { scope: 'models:read:self', state: 'fixed' },
      { scope: 'ai:write:budgeted', state: 'withheld' },
    ]);
  });

  /**
   * 🔴 `revoked` STILL WINS OVER `withheld`. On a MIGRATED database a viewer's own whole-grant
   * revoke sets BOTH `revoked_at` and `revoked_scopes` (`revokeScopes`' `fullyRevoked` branch), so
   * these two facts co-occur — and "You withdrew this" is the more specific and more useful of the
   * two. Only a scope NOT in `revoked_scopes` is the reset shape.
   *
   * MUTATION THAT MUST KILL IT: move the `withheld` test above the `revoked.has(scope)` test.
   */
  test('🔴 a scope the viewer revoked stays `revoked` even on a withheld grant', () => {
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted', 'posts:write:self'],
      revokedScopes: ['posts:write:self'],
      revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
      grantedScopes: [],
      grantWithheldAt: new Date('2026-09-17T12:00:00Z'),
    });
    expect(
      rows,
      'a permission the viewer withdrew was relabelled "on hold", which drops the only marker ' +
        'that records their own action'
    ).toEqual([
      { scope: 'ai:write:budgeted', state: 'withheld' },
      { scope: 'posts:write:self', state: 'revoked' },
    ]);
  });

  /**
   * THE CONTROL: the SAME fixture with the flag null is `not-granted`, which is what makes the
   * arms above measure the flag rather than anything else about the shape.
   */
  test('CONTROL: without the withheld flag the same shape is `not-granted`', () => {
    const rows = buildScopeConsentRows({
      scopes: ['ai:write:budgeted'],
      revokedScopes: [],
      revokableScopes: ['ai:write:budgeted'],
      grantedScopes: [],
      grantWithheldAt: null,
    });
    expect(rows).toEqual([{ scope: 'ai:write:budgeted', state: 'not-granted' }]);
  });

  /**
   * 🔴 AN ABSENT `grantedScopes` IS `unknown`, NOT "granted nothing". The three viewer-side fields
   * arrive together or not at all (a pre-phase-2 pod during a rollout's mixed-version window sends
   * none of them), so coalescing a missing granted set to `[]` would turn every row of such a
   * payload into a `not-granted` claim about the viewer's own consent that nothing supports.
   *
   * The pair is asserted TOGETHER for the same reason the `revokableScopes` pair above is: the
   * claim IS that the two inputs produce different states.
   *
   * MUTATION THAT MUST KILL IT: `grantedScopes ?? []` in `buildScopeConsentRows`, or dropping
   * `granted === undefined` from the `unknown` test.
   */
  test('🔴 ABSENT grantedScopes yields `unknown`; EMPTY yields `not-granted`', () => {
    const shared = {
      scopes: ['ai:write:budgeted'],
      revokedScopes: [],
      revokableScopes: ['ai:write:budgeted'],
    };
    expect(buildScopeConsentRows({ ...shared, grantedScopes: undefined })).toEqual([
      { scope: 'ai:write:budgeted', state: 'unknown' },
    ]);
    expect(buildScopeConsentRows({ ...shared, grantedScopes: [] })).toEqual([
      { scope: 'ai:write:budgeted', state: 'not-granted' },
    ]);
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
   * 🔴 ITS OWN TEST, BECAUSE AS ONE TEST THE COVERAGE ASSERTION WAS UNREACHABLE. This used to be the
   * first line of the test below, as `expect(exempt.length, …).toBe(7)`. When upstream added an
   * eighth exempt scope (`goods:read:self`) that line failed FIRST, so the `missing` assertion on the
   * next line — the one that actually checks every exempt scope has a note — never executed, and the
   * gap it exists to report was invisible behind a red count. A guard an earlier assertion in the
   * same test always short-circuits is not a weak guard, it is a DEAD one, and it stayed dead through
   * a full green suite because the count only started failing at the moment the coverage broke.
   *
   * So: the non-emptiness control lives here, the coverage check lives below, and neither can mask
   * the other. Both are cheap; independence is the point.
   *
   * 🔴 AND IT IS NO LONGER A COUNT. The property this arm needs is "the population is not empty" —
   * `toBeGreaterThan(0)` says exactly that and cannot rot. The EXACT set is pinned once, deliberately,
   * in `server/services/blocks/__tests__/scope-grant.service.test.ts`; retyping a number here only
   * duplicated that tripwire in a file that does not own it, and broke a merge for no added coverage.
   */
  test('🔴 the exempt population is non-empty, and the note map covers exactly it', () => {
    const exempt = consentExemptScopeList();
    expect(exempt.length, 'the exempt list is empty — this test checks nothing').toBeGreaterThan(0);
    // 🔴 DERIVED ON BOTH SIDES, so it catches BOTH drift directions with no literal to bump: an
    // exemption added server-side without a note here (the viewer silently drops to the generic
    // sentence), and a note added here for a scope that is not exempt (dead copy that no row can
    // ever render). Sorted because neither source promises an order.
    expect(
      [...exempt].sort(),
      'FIXED_SCOPE_NOTES keys and the server exempt set have diverged'
    ).toEqual(Object.keys(FIXED_SCOPE_NOTES).sort());
  });

  /**
   * 🔴 THE POPULATION IS THE SERVER'S EXEMPT LIST, NOT A LITERAL LIST RETYPED HERE. A retyped
   * list passes forever after the real set changes, which is the exact drift this whole arc keeps
   * paying for. `consentExemptScopeList()` is a COPY of the set `partitionByConsent` consults.
   */
  test('every consent-exempt scope has a SPECIFIC note, not the generic fallback', () => {
    const exempt = consentExemptScopeList();
    // Non-emptiness is asserted independently above; repeated here only so this loop cannot be
    // vacuous if this test is ever run in isolation. NOT a count — see the docblock above.
    expect(exempt.length, 'the exempt list is empty — this test checks nothing').toBeGreaterThan(0);
    const missing = exempt.filter((scope) => !(scope in FIXED_SCOPE_NOTES));
    expect(missing, 'exempt scopes with no specific note').toEqual([]);
    for (const scope of exempt) {
      expect(fixedScopeNote(scope), scope).toBe(FIXED_SCOPE_NOTES[scope]);
      // Each note has to say the thing the row exists to say. Asserted as a property of the
      // string rather than by pinning each sentence: this is a "does it answer the question"
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
