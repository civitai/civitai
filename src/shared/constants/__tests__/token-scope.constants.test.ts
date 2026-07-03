import { describe, it, expect } from 'vitest';
import {
  TokenScope,
  ALL_SCOPES,
  tokenScopeLabels,
} from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

describe('TokenScope constants', () => {
  it('AppBlocksSubmit is bit 25 (1 << 25 = 33554432)', () => {
    expect(TokenScope.AppBlocksSubmit).toBe(1 << 25);
    expect(TokenScope.AppBlocksSubmit).toBe(33554432);
  });

  it('Full is UNCHANGED at 33554431 and EXCLUDES AppBlocksSubmit', () => {
    // Critical backward-compat invariant: existing personal keys persist
    // tokenScope = 33554431. Changing Full would silently re-interpret them.
    expect(TokenScope.Full).toBe(33554431);
    expect(TokenScope.Full).toBe((1 << 25) - 1);
    // AppBlocksSubmit is opt-in and NOT folded into Full.
    expect(Flags.hasFlag(TokenScope.Full, TokenScope.AppBlocksSubmit)).toBe(false);
  });

  it('ALL_SCOPES includes every defined bit, including AppBlocksSubmit', () => {
    expect(Flags.hasFlag(ALL_SCOPES, TokenScope.AppBlocksSubmit)).toBe(true);
    expect(Flags.hasFlag(ALL_SCOPES, TokenScope.UserRead)).toBe(true);
    expect(Flags.hasFlag(ALL_SCOPES, TokenScope.VaultWrite)).toBe(true);
    // ALL_SCOPES = Full | AppBlocksSubmit (the only opt-in bit today).
    expect(ALL_SCOPES).toBe(TokenScope.Full | TokenScope.AppBlocksSubmit);
    expect(ALL_SCOPES).toBe(67108863); // (1 << 26) - 1
  });

  it('a UserRead|AppBlocksSubmit token (the civitai-cli scope) is within ALL_SCOPES but exceeds Full', () => {
    const cliScope = TokenScope.UserRead | TokenScope.AppBlocksSubmit;
    expect(cliScope).toBe(33554433);
    // Exceeds Full — this is why the OAuth bound checks use ALL_SCOPES, not Full.
    expect(cliScope > TokenScope.Full).toBe(true);
    expect(cliScope <= ALL_SCOPES).toBe(true);
  });

  it('hasFlag detects the AppBlocksSubmit bit precisely', () => {
    const scoped = TokenScope.UserRead | TokenScope.AppBlocksSubmit;
    expect(Flags.hasFlag(scoped, TokenScope.AppBlocksSubmit)).toBe(true);
    // A Full token (no AppBlocksSubmit) must NOT report the bit.
    expect(Flags.hasFlag(TokenScope.Full, TokenScope.AppBlocksSubmit)).toBe(false);
    // A bare UserRead token must NOT report the bit.
    expect(Flags.hasFlag(TokenScope.UserRead, TokenScope.AppBlocksSubmit)).toBe(false);
  });

  it('AppBlocksSubmit has a human-readable consent label', () => {
    expect(tokenScopeLabels[TokenScope.AppBlocksSubmit]).toBe('Submit Apps for review');
  });
});
