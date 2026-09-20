import { describe, expect, it } from 'vitest';
import {
  APP_BLOCK_OAUTH_CLIENT_ID_PREFIX,
  BLOCK_CONSENT_AUTHOR_FEE_BODY,
  BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY,
  blockConsentAuthorFeeSentence,
  assertSensitiveScopesJustified,
  BLOCK_SCOPE_TO_OAUTH_BIT,
  deriveOauthBitmaskFromBlockScopes,
  isAppBlockOauthClientId,
  isKnownBlockScope,
  isSensitiveBlockScope,
  SENSITIVE_BLOCK_SCOPES,
  sensitiveScopeJustificationError,
  SKIP_OAUTH_CHECK,
  unjustifiedSensitiveScopes,
  validateBlockScopesAgainstOauthClient,
} from '../block-scope.constants';
import { TokenScope } from '../token-scope.constants';

describe('block-scope.constants', () => {
  it('maps known scopes to the right bits', () => {
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['models:read:self']).toBe(TokenScope.ModelsRead);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['ai:write:budgeted']).toBe(TokenScope.AIServicesWrite);
    // storage scopes intentionally have no OAuth bit (SKIP sentinel).
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['apps:storage:read']).toBe(SKIP_OAUTH_CHECK);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['apps:storage:write']).toBe(SKIP_OAUTH_CHECK);
  });

  it('apps:storage:* are now declarable (known) scopes', () => {
    // Fix 3 / audit A5: storage was previously unknown, so a manifest couldn't
    // even list it and resolveStorageContext never gated on it (ambient cap).
    expect(isKnownBlockScope('apps:storage:read')).toBe(true);
    expect(isKnownBlockScope('apps:storage:write')).toBe(true);
  });

  it('the removed decorative scopes are no longer known (deprecated)', () => {
    // media:read:owned / block:settings:read / block:settings:write were
    // declared/validated/mintable but had NO runtime capability that checked
    // them (purely decorative), so they were removed from the vocabulary. A
    // manifest declaring them now fails validation, and a token carrying one is
    // denied at the runtime gate — see the middleware + validator tests.
    expect(isKnownBlockScope('media:read:owned')).toBe(false);
    expect(isKnownBlockScope('block:settings:read')).toBe(false);
    expect(isKnownBlockScope('block:settings:write')).toBe(false);
    expect('media:read:owned' in BLOCK_SCOPE_TO_OAUTH_BIT).toBe(false);
    expect('block:settings:read' in BLOCK_SCOPE_TO_OAUTH_BIT).toBe(false);
    expect('block:settings:write' in BLOCK_SCOPE_TO_OAUTH_BIT).toBe(false);
  });

  it('isKnownBlockScope rejects unknown strings', () => {
    expect(isKnownBlockScope('models:read:self')).toBe(true);
    expect(isKnownBlockScope('not:a:scope')).toBe(false);
  });

  // 🔴 `in` walks the prototype chain, so with `scope in BLOCK_SCOPE_TO_OAUTH_BIT`
  // every inherited Object.prototype key answered "known scope". Callers treat a
  // `true` here as "part of the fixed platform vocabulary" and several then read
  // BLOCK_SCOPE_TO_OAUTH_BIT[scope] expecting a number — for these keys that read
  // returns a FUNCTION. The predicate is an OWN-property test; this pins it.
  const PROTOTYPE_KEYS = [
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];

  it('isKnownBlockScope rejects inherited Object.prototype keys (no prototype-chain bypass)', () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(isKnownBlockScope(key), `${key} must not be a known scope`).toBe(false);
    }
    // The bypass this guards against: `in` says yes to every one of them.
    expect(PROTOTYPE_KEYS.filter((k) => k in BLOCK_SCOPE_TO_OAUTH_BIT)).toHaveLength(
      PROTOTYPE_KEYS.length
    );
  });

  it('prototype keys contribute nothing downstream of the predicate', () => {
    // deriveOauthBitmaskFromBlockScopes and validateBlockScopesAgainstOauthClient
    // both index the map right after the predicate; a prototype key must never
    // reach that indexing.
    expect(deriveOauthBitmaskFromBlockScopes(PROTOTYPE_KEYS)).toBe(0);
    const check = validateBlockScopesAgainstOauthClient(PROTOTYPE_KEYS, TokenScope.Full);
    expect(check.valid).toBe(false);
    expect(check.rejectedScopes.sort()).toEqual([...PROTOTYPE_KEYS].sort());
  });

  describe('SENSITIVE_BLOCK_SCOPES / isSensitiveBlockScope', () => {
    const EXPECTED_SENSITIVE = [
      'ai:write:budgeted',
      'social:tip:self',
      'buzz:read:self',
      'collections:read:private',
      'apps:storage:shared:write',
      'posts:write:self',
    ];

    it('flags exactly the 6 designated sensitive scopes', () => {
      expect([...SENSITIVE_BLOCK_SCOPES].sort()).toEqual([...EXPECTED_SENSITIVE].sort());
      for (const scope of EXPECTED_SENSITIVE) {
        expect(isSensitiveBlockScope(scope)).toBe(true);
      }
    });

    it('does NOT flag normal (non-sensitive) known scopes', () => {
      for (const scope of [
        'models:read:self',
        'user:read:self',
        'apps:storage:read',
        'apps:storage:write',
        'apps:storage:shared:read',
        'collections:read:self',
        'collections:write:self',
      ]) {
        expect(isSensitiveBlockScope(scope)).toBe(false);
      }
    });

    it('does NOT flag unknown / removed scopes', () => {
      expect(isSensitiveBlockScope('not:a:scope')).toBe(false);
      expect(isSensitiveBlockScope('media:read:owned')).toBe(false);
    });

    it('every sensitive scope is a currently-known scope (rename/removal guard)', () => {
      // If a scope is renamed/removed from the enforcement map, this guard fails
      // loudly so the sensitive set can never silently reference a dead scope.
      for (const scope of SENSITIVE_BLOCK_SCOPES) {
        expect(isKnownBlockScope(scope)).toBe(true);
        expect(scope in BLOCK_SCOPE_TO_OAUTH_BIT).toBe(true);
      }
    });
  });

  describe('unjustifiedSensitiveScopes (single-sourced submit + validate rule)', () => {
    it('flags a declared sensitive scope with NO scopeJustifications key at all', () => {
      expect(unjustifiedSensitiveScopes({ scopes: ['ai:write:budgeted'] })).toEqual([
        'ai:write:budgeted',
      ]);
    });

    it('flags a sensitive scope missing from a present scopeJustifications object', () => {
      expect(
        unjustifiedSensitiveScopes({
          scopes: ['ai:write:budgeted', 'buzz:read:self'],
          scopeJustifications: { 'buzz:read:self': 'show the balance' },
        })
      ).toEqual(['ai:write:budgeted']);
    });

    it('flags a sensitive scope whose justification is empty / whitespace-only', () => {
      expect(
        unjustifiedSensitiveScopes({
          scopes: ['ai:write:budgeted', 'social:tip:self'],
          scopeJustifications: { 'ai:write:budgeted': '', 'social:tip:self': '   ' },
        })
      ).toEqual(['ai:write:budgeted', 'social:tip:self']);
    });

    it('flags a sensitive scope whose justification is a non-string value', () => {
      expect(
        unjustifiedSensitiveScopes({
          scopes: ['ai:write:budgeted'],
          scopeJustifications: { 'ai:write:budgeted': 42 },
        })
      ).toEqual(['ai:write:budgeted']);
    });

    it('returns [] when every sensitive scope has a non-empty justification', () => {
      expect(
        unjustifiedSensitiveScopes({
          scopes: ['ai:write:budgeted', 'models:read:self'],
          scopeJustifications: { 'ai:write:budgeted': 'runs a generation the user asked for' },
        })
      ).toEqual([]);
    });

    it('returns [] for a manifest declaring only non-sensitive scopes, even with no justifications', () => {
      expect(
        unjustifiedSensitiveScopes({ scopes: ['models:read:self', 'user:read:self'] })
      ).toEqual([]);
    });

    it('returns [] when scopes is absent or not an array', () => {
      expect(unjustifiedSensitiveScopes({})).toEqual([]);
      expect(unjustifiedSensitiveScopes({ scopes: 'ai:write:budgeted' })).toEqual([]);
      expect(unjustifiedSensitiveScopes({ scopes: null })).toEqual([]);
    });

    it('dedupes a sensitive scope declared more than once', () => {
      expect(
        unjustifiedSensitiveScopes({ scopes: ['ai:write:budgeted', 'ai:write:budgeted'] })
      ).toEqual(['ai:write:budgeted']);
    });

    it('ignores a scopeJustifications that is not a plain object (array / null)', () => {
      expect(
        unjustifiedSensitiveScopes({ scopes: ['ai:write:budgeted'], scopeJustifications: [] })
      ).toEqual(['ai:write:budgeted']);
      expect(
        unjustifiedSensitiveScopes({ scopes: ['ai:write:budgeted'], scopeJustifications: null })
      ).toEqual(['ai:write:budgeted']);
    });
  });

  describe('assertSensitiveScopesJustified + sensitiveScopeJustificationError', () => {
    it('throws the scope-named message for an unjustified sensitive scope', () => {
      expect(() =>
        assertSensitiveScopesJustified({ scopes: ['ai:write:budgeted'] })
      ).toThrow(
        'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ai:write:budgeted'
      );
    });

    it('lists every unjustified sensitive scope in the message (comma-joined)', () => {
      expect(() =>
        assertSensitiveScopesJustified({ scopes: ['ai:write:budgeted', 'buzz:read:self'] })
      ).toThrow(
        'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ai:write:budgeted, buzz:read:self'
      );
    });

    it('does NOT throw when the sensitive scope is justified', () => {
      expect(() =>
        assertSensitiveScopesJustified({
          scopes: ['ai:write:budgeted'],
          scopeJustifications: { 'ai:write:budgeted': 'runs the generation' },
        })
      ).not.toThrow();
    });

    it('does NOT throw for non-sensitive-only scopes', () => {
      expect(() =>
        assertSensitiveScopesJustified({ scopes: ['models:read:self'] })
      ).not.toThrow();
    });

    it('sensitiveScopeJustificationError formats the exact submit/validate message', () => {
      expect(sensitiveScopeJustificationError(['ai:write:budgeted'])).toBe(
        'sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ai:write:budgeted'
      );
    });
  });

  describe('validateBlockScopesAgainstOauthClient', () => {
    it('passes when every requested scope has its bit', () => {
      const allowed = TokenScope.ModelsRead | TokenScope.UserRead;
      const result = validateBlockScopesAgainstOauthClient(
        ['models:read:self', 'user:read:self'],
        allowed
      );
      expect(result.valid).toBe(true);
      expect(result.rejectedScopes).toHaveLength(0);
    });

    it('rejects scopes whose bit is missing', () => {
      const allowed = TokenScope.ModelsRead;
      const result = validateBlockScopesAgainstOauthClient(
        ['models:read:self', 'buzz:read:self'],
        allowed
      );
      expect(result.valid).toBe(false);
      expect(result.rejectedScopes).toContain('buzz:read:self');
      expect(result.rejectedScopes).not.toContain('models:read:self');
    });

    it('accepts no-bit scopes regardless of bitmask', () => {
      const result = validateBlockScopesAgainstOauthClient(['apps:storage:read'], 0);
      expect(result.valid).toBe(true);
    });

    it('rejects the removed decorative scopes as unknown', () => {
      for (const removed of [
        'media:read:owned',
        'block:settings:read',
        'block:settings:write',
      ]) {
        const result = validateBlockScopesAgainstOauthClient([removed], TokenScope.Full);
        expect(result.valid).toBe(false);
        expect(result.rejectedScopes).toEqual([removed]);
      }
    });

    it('rejects unknown scopes outright', () => {
      const result = validateBlockScopesAgainstOauthClient(['not:a:scope'], TokenScope.Full);
      expect(result.valid).toBe(false);
      expect(result.rejectedScopes).toEqual(['not:a:scope']);
    });
  });

  describe('isAppBlockOauthClientId (audit A1 discriminator)', () => {
    it('matches the appblk- prefix used by approveRequest', () => {
      expect(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX).toBe('appblk-');
      expect(isAppBlockOauthClientId('appblk-hello')).toBe(true);
      expect(isAppBlockOauthClientId('appblk-generate-from-model')).toBe(true);
    });

    it('does NOT match genuine OAuth-apps client ids (uuidv4)', () => {
      // oauth-client.router create() uses uuidv4 — never appblk-prefixed.
      expect(isAppBlockOauthClientId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
      expect(isAppBlockOauthClientId('01ksd3np23js3gjhyx4pfgm0nc-app-blocks-hack')).toBe(false);
    });

    it('is null/undefined-safe', () => {
      expect(isAppBlockOauthClientId(null)).toBe(false);
      expect(isAppBlockOauthClientId(undefined)).toBe(false);
      expect(isAppBlockOauthClientId('')).toBe(false);
    });
  });

  describe('deriveOauthBitmaskFromBlockScopes (audit A1/A3/A4 scope cap)', () => {
    it('ORs the OAuth bits of the declared scopes', () => {
      expect(
        deriveOauthBitmaskFromBlockScopes(['models:read:self', 'user:read:self'])
      ).toBe(TokenScope.ModelsRead | TokenScope.UserRead);
    });

    it('returns 0 for an empty / scope-less manifest (NOT Full)', () => {
      expect(deriveOauthBitmaskFromBlockScopes([])).toBe(0);
      expect(deriveOauthBitmaskFromBlockScopes([])).not.toBe(TokenScope.Full);
    });

    it('SKIP_OAUTH_CHECK scopes contribute no bits', () => {
      // apps:storage:* are gated elsewhere (per-op server-side), not via the bit.
      expect(
        deriveOauthBitmaskFromBlockScopes([
          'apps:storage:read',
          'apps:storage:write',
        ])
      ).toBe(0);
    });

    it('ignores unknown scopes', () => {
      expect(
        deriveOauthBitmaskFromBlockScopes(['models:read:self', 'not:a:scope'])
      ).toBe(TokenScope.ModelsRead);
    });

    it('the derived ceiling never grants more than the manifest declares', () => {
      const scopes = ['models:read:self', 'ai:write:budgeted'];
      const ceiling = deriveOauthBitmaskFromBlockScopes(scopes);
      // A manifest re-validated against its own derived ceiling always passes
      // (the ceiling == manifest bits), but a scope NOT in the manifest is
      // rejected when checked against that ceiling.
      expect(validateBlockScopesAgainstOauthClient(scopes, ceiling).valid).toBe(true);
      expect(
        validateBlockScopesAgainstOauthClient(['buzz:read:self'], ceiling).valid
      ).toBe(false);
    });
  });
});

/**
 * The consent screen's AUTHOR-FEE sentence, which is GENERATED from the fee
 * configuration rather than written as prose.
 *
 * 🔴 WHY THAT MATTERS ENOUGH TO TEST. The sibling money sentence in the same file
 * (`BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY`) records five wordings that each
 * shipped FALSE, and the cure was to forbid figures there. A figure IS permitted
 * here only because it is a projection of the one constant the fee is computed
 * from — so what has to be pinned is the PROJECTION, not the words: the figures
 * must move when the config moves, and the sentence must degrade to the
 * figure-free form when the config stops being describable by one figure.
 */
describe('blockConsentAuthorFeeSentence', () => {
  const platform = { flatBuzz: 1, pctBasisPoints: 500 };

  it('renders the served figures, not hardcoded ones', () => {
    expect(blockConsentAuthorFeeSentence(platform)).toContain('at most 1 Buzz or 5% of');
  });

  it('🔴 the figures MOVE with the configuration', () => {
    // The mutation this kills: a sentence that reads the right fields but
    // interpolates a literal. Both legs differ from the platform values AND from
    // each other, so a hardcoded 1 or 5 cannot survive.
    const moved = blockConsentAuthorFeeSentence({ flatBuzz: 7, pctBasisPoints: 1250 });
    expect(moved).toContain('at most 7 Buzz or 12.5% of');
    expect(moved).not.toContain('1 Buzz');
    // 🔴 ANCHORED ON `or `, NOT A BARE `'5%'` — `12.5%` CONTAINS `5%`, so the
    // bare form failed against a correct implementation. That is the substring
    // trap this assertion is about: a negative that can match the very value it
    // is meant to distinguish from proves nothing in either direction.
    expect(moved).not.toContain('or 5%');
  });

  it('renders basis points at sub-percent resolution, without rounding to a whole', () => {
    // 550 bp is 5.5%. A `Math.round(bp / 100)` would render 6% — a figure the
    // config does not say, in the direction that over-states the fee.
    expect(blockConsentAuthorFeeSentence({ ...platform, pctBasisPoints: 550 })).toContain('5.5%');
  });

  it('🔴 claims only that a fee CAN apply, never that this app charges one', () => {
    // 🔴 THE DEFECT REVIEW CAUGHT. An earlier wording opened "This app charges a
    // developer fee on each generation", and the disclosure is PLATFORM-WIDE —
    // it takes no app id. Four reachable states falsify the categorical form: a
    // customComfy-only or pass-through-only app (both ledgered `charges: 0`), a
    // SELF-DEALING author, a fee-free generation type, and a degraded quote.
    for (const sentence of [
      blockConsentAuthorFeeSentence(platform),
      BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY,
    ]) {
      expect(sentence).toContain('can include a developer fee');
      expect(sentence).toContain('Not every generation is charged one.');
      expect(sentence).not.toContain('This app charges');
      expect(sentence).not.toContain('on each generation:');
    }
  });

  it('🔴 keeps "at most", which is the only thing making the percentage TRUE', () => {
    // The percentage leg is computed on `WorkflowCost.base`; a viewer reads "the
    // generation's cost" as `total`, which also carries per-resource licensing
    // fees, the lineage fee and tips. The figure is an UPPER BOUND, and editing
    // out "at most" turns it into a false equality. Pinned rather than left to a
    // comment, because `base <= total` is assumed here and not established.
    expect(blockConsentAuthorFeeSentence(platform)).toContain('at most 1 Buzz or 5% of that cost');
  });

  it('never names a raw generation-type id', () => {
    // Viewers have no vocabulary for `chat-completion`. "Not every generation is
    // charged one" reports that free cases EXIST — and covers the three other
    // ways a generation goes unfeed that an enumeration of types would miss —
    // without leaking an internal key onto a consent screen.
    expect(blockConsentAuthorFeeSentence(platform)).not.toContain('chat-completion');
    expect(BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY).not.toContain('chat-completion');
  });

  it('🔴 both wordings carry the invariant tail, including the Buzz-type honesty', () => {
    // Both money hops preserve the account type (`fromAccountType ===
    // toAccountType` on the charge AND the settlement), so a viewer spending
    // non-withdrawable Buzz funds a non-withdrawable credit. A sentence that
    // said "the developer earns Buzz" without this implies withdrawable earnings
    // the viewer's spend cannot produce.
    for (const sentence of [
      blockConsentAuthorFeeSentence(platform),
      BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY,
    ]) {
      expect(sentence).toContain(BLOCK_CONSENT_AUTHOR_FEE_BODY);
      expect(sentence).toContain('non-withdrawable');
      // 🔴 WHAT CIVITAI DOES, NOT WHAT THE APP SHOWS. The earlier wording —
      // "already included in the cost shown before each run" — was a claim about
      // a THIRD-PARTY renderer the platform does not control, and false on the
      // degraded-quote path. The platform controls the number it QUOTES.
      expect(sentence).toContain('adds the fee to the run price it quotes this app');
      expect(sentence).not.toContain('included in the cost shown');
    }
  });

  it('🔴 the figure-free fallback asserts NO figure', () => {
    // It is the branch taken when an override prices a type above the default,
    // i.e. exactly when "at most X or Y%" would be false. A digit in it would
    // re-introduce the class the budget warning's docblock exists to forbid.
    expect(BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY).not.toMatch(/\d/);
    expect(BLOCK_CONSENT_AUTHOR_FEE_RULE_ONLY).toContain('depends on the generation type');
  });
});
