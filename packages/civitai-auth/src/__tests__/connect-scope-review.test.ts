import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  TokenScope,
  tokenScopeLabels,
  SCOPE_JUSTIFICATION_MAX_LENGTH,
  SENSITIVE_TOKEN_SCOPES,
  isSensitiveTokenScope,
  tokenScopeMaskToList,
  tokenScopeKeyByBit,
  connectScopesSubsetOfCeiling,
  validateConnectScopeJustifications,
} from '../token-scope';

describe('tokenScopeKeyByBit', () => {
  it('maps a single bit to its enum-key', () => {
    expect(tokenScopeKeyByBit(TokenScope.ModelsRead)).toBe('ModelsRead');
    expect(tokenScopeKeyByBit(TokenScope.UserRead)).toBe('UserRead');
    expect(tokenScopeKeyByBit(TokenScope.AppBlocksDevTunnel)).toBe('AppBlocksDevTunnel');
  });

  it('returns undefined for an unknown / non-single bit', () => {
    expect(tokenScopeKeyByBit(0)).toBeUndefined(); // None sentinel
    expect(tokenScopeKeyByBit(TokenScope.Full)).toBeUndefined(); // aggregate, not a single bit
    expect(tokenScopeKeyByBit(1 << 30)).toBeUndefined(); // undefined bit
    expect(tokenScopeKeyByBit(TokenScope.UserRead | TokenScope.ModelsRead)).toBeUndefined(); // multi-bit
  });
});

describe('tokenScopeMaskToList', () => {
  it('empty mask (0) yields no scopes', () => {
    expect(tokenScopeMaskToList(0)).toEqual([]);
  });

  it('single-bit mask yields that scope with bit/key/label', () => {
    expect(tokenScopeMaskToList(TokenScope.ModelsRead)).toEqual([
      {
        bit: TokenScope.ModelsRead,
        key: 'ModelsRead',
        label: tokenScopeLabels[TokenScope.ModelsRead],
      },
    ]);
  });

  it('multi-bit mask yields every set scope, sorted by bit ascending', () => {
    const mask = TokenScope.MediaWrite | TokenScope.UserRead | TokenScope.ModelsRead;
    const list = tokenScopeMaskToList(mask);
    expect(list.map((s) => s.key)).toEqual(['UserRead', 'ModelsRead', 'MediaWrite']);
    for (const s of list) {
      expect(tokenScopeKeyByBit(s.bit)).toBe(s.key);
      expect(s.label).toBe(tokenScopeLabels[s.bit]);
    }
  });

  it('ignores bits not set in the mask (aggregate Full stays fully expanded)', () => {
    const list = tokenScopeMaskToList(TokenScope.Full);
    // Full is the OR of bits 0..24 → 25 single-bit scopes, none of them the two
    // opt-in bits (AppBlocksSubmit / AppBlocksDevTunnel) which are excluded.
    expect(list).toHaveLength(25);
    expect(list.some((s) => s.key === 'AppBlocksSubmit')).toBe(false);
    expect(list.some((s) => s.key === 'AppBlocksDevTunnel')).toBe(false);
  });
});

describe('connectScopesSubsetOfCeiling', () => {
  it('true when requested is a subset of the ceiling', () => {
    const ceiling = TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaRead;
    expect(connectScopesSubsetOfCeiling(0, ceiling)).toBe(true);
    expect(connectScopesSubsetOfCeiling(TokenScope.ModelsRead, ceiling)).toBe(true);
    expect(connectScopesSubsetOfCeiling(ceiling, ceiling)).toBe(true);
  });

  it('false when requested carries a bit outside the ceiling', () => {
    const ceiling = TokenScope.UserRead | TokenScope.ModelsRead;
    expect(
      connectScopesSubsetOfCeiling(TokenScope.ModelsRead | TokenScope.ModelsWrite, ceiling)
    ).toBe(false);
    expect(connectScopesSubsetOfCeiling(TokenScope.MediaDelete, ceiling)).toBe(false);
  });
});

describe('validateConnectScopeJustifications', () => {
  const requested = TokenScope.ModelsRead | TokenScope.MediaWrite;

  it('no errors when every key is a requested scope with a non-empty ≤500 value', () => {
    expect(
      validateConnectScopeJustifications(requested, {
        ModelsRead: 'We read models to render the gallery.',
        MediaWrite: 'We publish generated images on the user behalf.',
      })
    ).toEqual([]);
  });

  it('empty justifications ({}) is valid', () => {
    expect(validateConnectScopeJustifications(requested, {})).toEqual([]);
  });

  it('rejects an unknown / invalid scope key', () => {
    const errors = validateConnectScopeJustifications(requested, {
      NotAScope: 'x',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('NotAScope');
    expect(errors[0]).toContain('not a valid scope');
  });

  it('rejects an aggregate/sentinel key (Full / None)', () => {
    expect(validateConnectScopeJustifications(requested, { Full: 'x' })).toEqual([
      'scopeJustifications references "Full" which is not a valid scope',
    ]);
    expect(validateConnectScopeJustifications(requested, { None: 'x' })).toEqual([
      'scopeJustifications references "None" which is not a valid scope',
    ]);
  });

  it('rejects a valid scope key that is not among the requested scopes', () => {
    const errors = validateConnectScopeJustifications(requested, {
      ModelsDelete: 'We need to delete models.',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ModelsDelete');
    expect(errors[0]).toContain('not among the requested scopes');
  });

  it('rejects an empty value', () => {
    const errors = validateConnectScopeJustifications(requested, { ModelsRead: '' });
    expect(errors).toEqual(['scopeJustifications["ModelsRead"] must be a non-empty string']);
  });

  it('rejects a value longer than SCOPE_JUSTIFICATION_MAX_LENGTH', () => {
    const tooLong = 'a'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1);
    const errors = validateConnectScopeJustifications(requested, { ModelsRead: tooLong });
    expect(errors).toEqual([
      `scopeJustifications["ModelsRead"] must be ≤${SCOPE_JUSTIFICATION_MAX_LENGTH} chars`,
    ]);
  });

  it('accepts a value exactly at the length bound', () => {
    const atBound = 'a'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH);
    expect(validateConnectScopeJustifications(requested, { ModelsRead: atBound })).toEqual([]);
  });

  it('SCOPE_JUSTIFICATION_MAX_LENGTH is 500 (shared bound)', () => {
    expect(SCOPE_JUSTIFICATION_MAX_LENGTH).toBe(500);
  });
});

describe('SENSITIVE_TOKEN_SCOPES (OAuth sensitive taxonomy)', () => {
  // The auditable expected set — money (BuzzRead/SocialTip + buzz-spending writes),
  // private (UserRead), and every cross-user/account write+delete. Reads of public
  // data and the opt-in App-Block scopes are NOT sensitive.
  const EXPECTED_SENSITIVE =
    TokenScope.UserRead |
    TokenScope.UserWrite |
    TokenScope.ModelsWrite |
    TokenScope.ModelsDelete |
    TokenScope.MediaWrite |
    TokenScope.MediaDelete |
    TokenScope.ArticlesWrite |
    TokenScope.ArticlesDelete |
    TokenScope.BountiesWrite |
    TokenScope.BountiesDelete |
    TokenScope.AIServicesWrite |
    TokenScope.BuzzRead |
    TokenScope.CollectionsWrite |
    TokenScope.SocialWrite |
    TokenScope.SocialTip |
    TokenScope.NotificationsWrite |
    TokenScope.VaultWrite;

  it('is EXACTLY the expected sensitive bitmask', () => {
    expect(SENSITIVE_TOKEN_SCOPES).toBe(EXPECTED_SENSITIVE);
    // Spelled out as the set of enum-keys for a human to eyeball.
    expect(tokenScopeMaskToList(SENSITIVE_TOKEN_SCOPES).map((s) => s.key)).toEqual([
      'UserRead',
      'UserWrite',
      'ModelsWrite',
      'ModelsDelete',
      'MediaWrite',
      'MediaDelete',
      'ArticlesWrite',
      'ArticlesDelete',
      'BountiesWrite',
      'BountiesDelete',
      'AIServicesWrite',
      'BuzzRead',
      'CollectionsWrite',
      'SocialWrite',
      'SocialTip',
      'NotificationsWrite',
      'VaultWrite',
    ]);
  });

  it('every set bit is a DEFINED single-bit TokenScope (⊆ ALL_SCOPES, none dangling)', () => {
    // No bit outside the union of every defined scope bit.
    expect(SENSITIVE_TOKEN_SCOPES & ~ALL_SCOPES).toBe(0);
    // And each individual bit resolves to a real single-bit enum key.
    for (const { bit, key } of tokenScopeMaskToList(SENSITIVE_TOKEN_SCOPES)) {
      expect(tokenScopeKeyByBit(bit)).toBe(key);
    }
  });

  it('EXCLUDES the public-read + opt-in App-Block scopes', () => {
    for (const bit of [
      TokenScope.ModelsRead,
      TokenScope.MediaRead,
      TokenScope.ArticlesRead,
      TokenScope.BountiesRead,
      TokenScope.AIServicesRead,
      TokenScope.CollectionsRead,
      TokenScope.NotificationsRead,
      TokenScope.VaultRead,
      TokenScope.AppBlocksSubmit,
      TokenScope.AppBlocksDevTunnel,
    ]) {
      expect(SENSITIVE_TOKEN_SCOPES & bit).toBe(0);
    }
  });

  it('isSensitiveTokenScope — single-bit spot checks', () => {
    expect(isSensitiveTokenScope(TokenScope.ModelsWrite)).toBe(true);
    expect(isSensitiveTokenScope(TokenScope.UserRead)).toBe(true);
    expect(isSensitiveTokenScope(TokenScope.BuzzRead)).toBe(true);
    expect(isSensitiveTokenScope(TokenScope.SocialTip)).toBe(true);
    expect(isSensitiveTokenScope(TokenScope.ModelsRead)).toBe(false);
    expect(isSensitiveTokenScope(TokenScope.MediaRead)).toBe(false);
    expect(isSensitiveTokenScope(TokenScope.AppBlocksSubmit)).toBe(false);
    expect(isSensitiveTokenScope(0)).toBe(false);
  });

  it('isSensitiveTokenScope — a mask is sensitive iff it intersects the set', () => {
    // A read-only mask is not sensitive…
    expect(isSensitiveTokenScope(TokenScope.ModelsRead | TokenScope.MediaRead)).toBe(false);
    // …but add one sensitive bit and it is.
    expect(
      isSensitiveTokenScope(TokenScope.ModelsRead | TokenScope.ModelsWrite)
    ).toBe(true);
  });
});
