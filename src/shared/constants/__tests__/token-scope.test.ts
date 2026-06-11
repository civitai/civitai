import { describe, it, expect } from 'vitest';
import {
  TokenScope,
  TokenScopePresets,
  scopeNamesToBitmask,
  bitmaskToScopeNames,
  tokenScopeNameToFlag,
} from '~/shared/constants/token-scope.constants';

describe('scopeNamesToBitmask / bitmaskToScopeNames', () => {
  it('round-trips a representative set of canonical names', () => {
    const names = ['user:read', 'models:read', 'media:write', 'social:write'];
    const mask = scopeNamesToBitmask(names);
    expect(mask).toBe(
      TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.MediaWrite | TokenScope.SocialWrite
    );
    expect(bitmaskToScopeNames(mask).sort()).toEqual([...names].sort());
  });

  it('round-trips every individual canonical scope name', () => {
    for (const name of Object.keys(tokenScopeNameToFlag)) {
      if (name === 'full') continue;
      const mask = scopeNamesToBitmask([name]);
      expect(bitmaskToScopeNames(mask)).toContain(name);
    }
  });

  it('ignores unknown names in scopeNamesToBitmask', () => {
    expect(scopeNamesToBitmask(['user:read', 'bogus:scope'])).toBe(TokenScope.UserRead);
  });

  it('bitmaskToScopeNames never emits "full"', () => {
    expect(bitmaskToScopeNames(TokenScope.Full)).not.toContain('full');
    // a full mask decomposes into all individual names
    expect(bitmaskToScopeNames(TokenScope.Full)).toContain('models:delete');
  });
});

describe('MCP scope cap policy', () => {
  const cap = TokenScopePresets.MCPMaxAllowed;

  it('excludes all Delete scopes', () => {
    expect(cap & TokenScope.ModelsDelete).toBe(0);
    expect(cap & TokenScope.MediaDelete).toBe(0);
    expect(cap & TokenScope.ArticlesDelete).toBe(0);
    expect(cap & TokenScope.BountiesDelete).toBe(0);
  });

  it('excludes buzz-spending scopes', () => {
    expect(cap & TokenScope.SocialTip).toBe(0);
    expect(cap & TokenScope.AIServicesWrite).toBe(0);
    expect(cap & TokenScope.BountiesWrite).toBe(0);
  });

  it('never equals Full', () => {
    expect(cap).not.toBe(TokenScope.Full);
  });

  it('clamps a models:delete request down to nothing extra (the cap drops it)', () => {
    // Simulate the /register clamp: requested = models:read + models:delete.
    const requested = TokenScope.ModelsRead | TokenScope.ModelsDelete;
    const capped = (requested & cap) | TokenScope.UserRead;
    expect(capped & TokenScope.ModelsDelete).toBe(0);
    expect(capped & TokenScope.ModelsRead).toBe(TokenScope.ModelsRead);
    expect(bitmaskToScopeNames(capped)).not.toContain('models:delete');
    expect(bitmaskToScopeNames(capped)).toContain('models:read');
  });

  it('includes the expected safe write scopes', () => {
    expect(cap & TokenScope.MediaWrite).toBe(TokenScope.MediaWrite);
    expect(cap & TokenScope.ModelsWrite).toBe(TokenScope.ModelsWrite);
    expect(cap & TokenScope.SocialWrite).toBe(TokenScope.SocialWrite);
  });
});
