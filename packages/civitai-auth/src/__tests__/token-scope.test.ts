import { describe, it, expect } from 'vitest';
import {
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
