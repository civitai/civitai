import { describe, expect, it } from 'vitest';
import {
  resolveHostConsentNotice,
  resolveRequestConsent,
  resolveUngrantableConsentNotice,
  UNGRANTABLE_CONSENT_TOAST,
  type HostConsentNoticeInput,
} from '../requestConsentGate';

/**
 * Lazy-consent (REQUEST_CONSENT) — the host's handler must:
 *   (1) only open the consent UI once BLOCK_READY has landed (status==='ready'),
 *       so a pre-handshake block can't pop a permission modal before any
 *       interaction (same posture as REQUEST_SIGN_IN / OPEN_BUZZ_PURCHASE);
 *   (2) drop the request when there's nothing to consent to (no missing scopes);
 *   (3) grant the missing set the MINT computed — never scopes the block claims.
 *
 * resolveRequestConsent is the pure gate the handler delegates to. Origin +
 * event.source pinning is enforced upstream by usePostMessage (covered by
 * usePostMessage.test.ts) — these tests pin the readiness + non-empty gate,
 * mirroring resolveRequestSignIn.
 */
describe('resolveRequestConsent (REQUEST_CONSENT gate)', () => {
  const missing = ['ai:write:budgeted', 'buzz:read:self'];

  it('before BLOCK_READY → ignored (returns null), no consent UI', () => {
    expect(resolveRequestConsent('loading', missing)).toBeNull();
  });

  it('does not honor the request during timeout / fatal / no_token fallbacks', () => {
    expect(resolveRequestConsent('timeout', missing)).toBeNull();
    expect(resolveRequestConsent('fatal', missing)).toBeNull();
    expect(resolveRequestConsent('no_token', missing)).toBeNull();
  });

  it('after BLOCK_READY with nothing missing → no-op (returns null)', () => {
    expect(resolveRequestConsent('ready', [])).toBeNull();
    expect(resolveRequestConsent('ready', undefined as unknown as string[])).toBeNull();
  });

  it('after BLOCK_READY with missing scopes → returns the server-known missing set to grant', () => {
    expect(resolveRequestConsent('ready', missing)).toEqual(missing);
    expect(resolveRequestConsent('ready', ['ai:write:budgeted'])).toEqual(['ai:write:budgeted']);
  });
});

// ===========================================================================
// MOVED HERE FROM `pageBlockHostLogic.test.ts` ALONG WITH THE FUNCTION. It was
// never page-specific: it is the REFUSAL half of the gate above, and both host
// surfaces now call it. The cases are unchanged from that file — a move, not a
// rewrite — so a reviewer can diff them against the original.
// ===========================================================================
describe('resolveUngrantableConsentNotice (Issue B — un-grantable dev-preview consent → toast)', () => {
  it('notifies and NAMES the un-grantable subset when a requested scope is neither granted NOR missing (clamped at mint)', () => {
    // dev-tunnel preview: the token carries models:read:self; the block asks for
    // a scope the tunnel allowlist withheld → not granted, not addable via consent.
    expect(
      resolveUngrantableConsentNotice(['apps:storage:read'], ['models:read:self'], [])
    ).toEqual({ notify: true, scopes: ['apps:storage:read'] });
  });

  it('does NOT notify for the BENIGN already-granted case (block re-requests a held scope)', () => {
    expect(
      resolveUngrantableConsentNotice(
        ['buzz:read:self'],
        ['buzz:read:self', 'models:read:self'],
        []
      )
    ).toEqual({ notify: false, scopes: [] });
  });

  it('does NOT notify when the requested scope is grantable via consent (it is in missingScopes) — modal path owns it', () => {
    expect(
      resolveUngrantableConsentNotice(
        ['ai:write:budgeted'],
        ['models:read:self'],
        ['ai:write:budgeted']
      )
    ).toEqual({ notify: false, scopes: [] });
  });

  it('does NOT notify when the block sends no hint / a garbage hint (never a fragile heuristic)', () => {
    const silent = { notify: false, scopes: [] };
    expect(resolveUngrantableConsentNotice(undefined, ['models:read:self'], [])).toEqual(silent);
    expect(resolveUngrantableConsentNotice([], ['models:read:self'], [])).toEqual(silent);
    expect(resolveUngrantableConsentNotice('nope', ['models:read:self'], [])).toEqual(silent);
    expect(resolveUngrantableConsentNotice([1, null, ''], ['models:read:self'], [])).toEqual(
      silent
    );
  });

  it('reports ONLY the un-grantable scopes from a mixed hint (drops granted + missing), sorted+deduped', () => {
    expect(
      resolveUngrantableConsentNotice(
        [
          'apps:storage:write',
          'apps:storage:read',
          'apps:storage:write',
          'buzz:read:self',
          'ai:write:budgeted',
        ],
        ['buzz:read:self'], // already granted
        ['ai:write:budgeted'] // grantable via consent
      )
    ).toEqual({ notify: true, scopes: ['apps:storage:read', 'apps:storage:write'] });
  });

  it('tolerates an undefined missingScopes', () => {
    expect(
      resolveUngrantableConsentNotice(['apps:storage:read'], ['models:read:self'], undefined)
    ).toEqual({ notify: true, scopes: ['apps:storage:read'] });
  });

  /**
   * 🔴 The untrusted-echo half. `rawScopesHint` comes from the block's own frame
   * and the resulting `scopes` are posted back over the bridge for block UI to
   * render, so only the fixed platform vocabulary may appear in them — while the
   * DECISION stays on the unfiltered set, or an un-grantable scope the vocabulary
   * doesn't know would silently produce no refusal at all.
   */
  describe('untrusted hint — the payload is filtered, the decision is not', () => {
    it('drops markup / junk / oversized strings from `scopes` but STILL notifies', () => {
      const out = resolveUngrantableConsentNotice(
        ['<img src=x onerror=alert(1)>', 'not:a:real:scope', 'A'.repeat(5000)],
        ['models:read:self'],
        []
      );
      // The refusal survives — this is the toast + bridge-push trigger.
      expect(out.notify).toBe(true);
      // Nothing untrusted is echoed back.
      expect(out.scopes).toEqual([]);
    });

    it('keeps the known scopes and drops the unknown ones from a MIXED hint, order preserved', () => {
      const out = resolveUngrantableConsentNotice(
        ['apps:storage:write', 'not:a:real:scope', 'apps:storage:read', '<script>x</script>'],
        ['models:read:self'],
        []
      );
      expect(out).toEqual({ notify: true, scopes: ['apps:storage:read', 'apps:storage:write'] });
    });

    it('does not treat inherited Object.prototype keys as known scopes (own-property test)', () => {
      // `isKnownBlockScope` is `Object.prototype.hasOwnProperty.call(...)`, not
      // `in` — `in` walked the prototype chain and let these through as "known".
      const inherited = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty'];
      const out = resolveUngrantableConsentNotice(inherited, ['models:read:self'], []);
      expect(out.notify).toBe(true);
      expect(out.scopes).toEqual([]);
    });

    it('still notifies when the ONLY un-grantable scope is unknown (the refusal is the signal)', () => {
      // The regression guard for the obvious-but-wrong fix: filtering the
      // DECISION by `isKnownBlockScope` would make this silent, removing an
      // existing user-visible behaviour.
      const out = resolveUngrantableConsentNotice(['totally:made:up'], ['models:read:self'], []);
      expect(out.notify).toBe(true);
      expect(out.scopes).toEqual([]);
    });
  });
});

// ===========================================================================
// resolveHostConsentNotice — THE HOST-SIDE BACKSTOP'S PREDICATE.
//
// 🔴 THESE ARE REGRESSION CASES FOR A MEASURED ABSENCE, not invariant guards.
// Before this predicate existed the rule was open-coded in `PageBlockHost`'s JSX
// and NOWHERE in `IframeHost` — `git grep -c needsConsent` read 7 and 0 — so on
// the model-slot surface no host-side term decided anything at all.
//
// Every term gets its own killing case, and every negative varies ONE variable:
// a fixture that moves two terms at once cannot attribute the `null` to either,
// which is how `needsConsent &&` survived in the page host's condition with no
// mutation that could kill it.
// ===========================================================================

describe('resolveHostConsentNotice (the host-side missing-permissions backstop)', () => {
  // Distinct from every scope named in any assertion below, so a pass cannot be a
  // fixture colliding with a constant.
  const MISSING = ['ai:write:budgeted', 'buzz:read:self'];
  const base: HostConsentNoticeInput = {
    status: 'ready',
    needsConsent: true,
    missingScopes: MISSING,
    dismissedFor: null,
    appBlockId: 'apb_test',
  };

  it('returns the mint-computed missing set when every term is satisfied', () => {
    // Returned BY IDENTITY of contents, not a re-derivation: the host opens the
    // consent modal on exactly what the server withheld.
    expect(resolveHostConsentNotice(base)).toEqual(MISSING);
  });

  it('term: status — nothing before BLOCK_READY, on any non-ready value', () => {
    for (const status of ['loading', 'timeout', 'fatal', 'no_token'] as const) {
      expect(resolveHostConsentNotice({ ...base, status })).toBeNull();
    }
  });

  it('term: needsConsent — false suppresses it EVEN WITH a non-empty missing set', () => {
    // ⚠️ NOT A STATE THE MINT PRODUCES — it sets `needsConsent = missing.length > 0`,
    // so the two always agree in production. This pins the PROP CONTRACT: the
    // predicate branches on the server's own verdict rather than re-deriving it from
    // the array, and without this case that term is unkillable.
    expect(resolveHostConsentNotice({ ...base, needsConsent: false })).toBeNull();
  });

  it('term: needsConsent — `undefined` (a legacy mint response) also suppresses it', () => {
    // `!== true`, not `!needsConsent`: a response that carries no such field must
    // read as "nothing to prompt for", never as "prompt by default".
    expect(resolveHostConsentNotice({ ...base, needsConsent: undefined })).toBeNull();
  });

  it('term: missingScopes — an empty or absent set yields nothing (needsConsent still true)', () => {
    // ⚠️ Also not a mint-produced state; same reason as above. One variable each.
    expect(resolveHostConsentNotice({ ...base, missingScopes: [] })).toBeNull();
    expect(resolveHostConsentNotice({ ...base, missingScopes: undefined })).toBeNull();
  });

  it('term: dismissedFor — a dismissal for THIS app suppresses it', () => {
    expect(resolveHostConsentNotice({ ...base, dismissedFor: 'apb_test' })).toBeNull();
  });

  it('term: dismissedFor — a dismissal for a DIFFERENT app does NOT', () => {
    // The state is keyed on the app, not a boolean: a slot that swaps installs
    // without unmounting must not carry a dismissal across to another app's
    // permissions. A `dismissedFor != null` check would pass every other case here
    // and fail exactly this one.
    expect(resolveHostConsentNotice({ ...base, dismissedFor: 'apb_other' })).toEqual(MISSING);
  });

  it('term: suppressed — wins over every other term, and defaults to off', () => {
    expect(resolveHostConsentNotice({ ...base, suppressed: true })).toBeNull();
    expect(resolveHostConsentNotice({ ...base, suppressed: false })).toEqual(MISSING);
    // Absent ⇒ not suppressed. `IframeHost` never passes it, so this is the model
    // slot's actual call shape.
    const { suppressed: _omitted, ...withoutTerm } = { ...base, suppressed: true };
    expect(resolveHostConsentNotice(withoutTerm)).toEqual(MISSING);
  });

  it('cannot disagree with `resolveRequestConsent` about when consent is offerable', () => {
    // The seam: the host-OFFERED notice and the block-REQUESTED modal must open on
    // the same conditions, because the notice's own Review button re-resolves through
    // `resolveRequestConsent` at click time. This asserts the RELATIONSHIP over the
    // full cross-product of the two shared inputs, so it fails if either side gains a
    // condition the other lacks — not just on the happy path.
    for (const status of ['loading', 'ready', 'timeout', 'fatal', 'no_token'] as const) {
      for (const missingScopes of [[], MISSING, ['apps:storage:read']]) {
        expect(resolveHostConsentNotice({ ...base, status, missingScopes })).toEqual(
          resolveRequestConsent(status, missingScopes)
        );
      }
    }
  });
});

describe('UNGRANTABLE_CONSENT_TOAST', () => {
  it('says nothing about a "preview" — it is shown on the live page and the model slot too', () => {
    // 🔴 A GUARD ON THE WHOLE STRING, not on a word. The page host's original copy
    // claimed the permission "isn't available in this preview", which is false
    // wherever the un-grantable state arises from an ordinary mint clamp rather than
    // a dev tunnel — and outright wrong on a model page. Pinning the normalised
    // string rather than grepping for "preview" means a reword has to be deliberate.
    expect(UNGRANTABLE_CONSENT_TOAST).toEqual({
      title: 'Permission unavailable',
      message: 'This app requested a permission that isn\u2019t available here.',
    });
  });
});
