import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  TokenScope,
  TokenScopePresets,
  tokenScopeLabels,
  getScopeLabel,
} from '../token-scope';

describe('TokenScope bitmask (shared contract — must not drift)', () => {
  it('keeps the canonical bit values', () => {
    expect(TokenScope.UserRead).toBe(1);
    expect(TokenScope.AIServicesWrite).toBe(1 << 15);
    expect(TokenScope.VaultWrite).toBe(1 << 24);
    expect(TokenScope.Full).toBe((1 << 25) - 1);
  });

  it('presets compose via OR and round-trip through getScopeLabel', () => {
    expect(getScopeLabel(TokenScope.Full)).toBe('Full Access');
    expect(getScopeLabel(TokenScopePresets.ReadOnly)).toBe('Read Only');
    expect(getScopeLabel(TokenScopePresets.Creator)).toBe('Creator');
    expect(getScopeLabel(TokenScopePresets.AIServices)).toBe('AI Services');
    expect(getScopeLabel(null)).toBe('Legacy');
    expect(getScopeLabel(TokenScope.UserRead | TokenScope.VaultWrite)).toBe('Custom');
  });

  it('every read/write scope has a UI label', () => {
    expect(tokenScopeLabels[TokenScope.UserRead]).toBeTruthy();
    expect(tokenScopeLabels[TokenScope.AIServicesWrite]).toBeTruthy();
  });
});

describe('AppBlocksDevTunnel (opt-in scope — NOT part of Full)', () => {
  it('is bit 26 = 67108864', () => {
    expect(TokenScope.AppBlocksDevTunnel).toBe(1 << 26);
    expect(TokenScope.AppBlocksDevTunnel).toBe(67108864);
  });

  it('is EXCLUDED from Full (Full stays frozen at (1<<25)-1)', () => {
    expect(TokenScope.Full).toBe(33554431);
    // hasFlag-style subset test: the bit must NOT be present in Full.
    expect(TokenScope.Full & TokenScope.AppBlocksDevTunnel).toBe(0);
  });

  it('IS included in ALL_SCOPES (the computed upper bound)', () => {
    expect(ALL_SCOPES & TokenScope.AppBlocksDevTunnel).toBe(TokenScope.AppBlocksDevTunnel);
    // Full is exactly ALL_SCOPES minus the two opt-in bits.
    expect(ALL_SCOPES).toBe(
      TokenScope.Full | TokenScope.AppBlocksSubmit | TokenScope.AppBlocksDevTunnel
    );
  });

  it('has a consent-screen label', () => {
    expect(tokenScopeLabels[TokenScope.AppBlocksDevTunnel]).toBeTruthy();
  });

  it('is NOT folded into any TokenScopePreset (opt-in, like AppBlocksSubmit)', () => {
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      // Full is a preset alias for TokenScope.Full, which itself excludes the bit.
      expect(
        (preset & TokenScope.AppBlocksDevTunnel) === 0,
        `preset ${name} must not carry AppBlocksDevTunnel`
      ).toBe(true);
    }
  });
});
