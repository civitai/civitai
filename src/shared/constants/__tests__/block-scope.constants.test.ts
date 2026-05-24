import { describe, expect, it } from 'vitest';
import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '../block-scope.constants';
import { TokenScope } from '../token-scope.constants';

describe('block-scope.constants', () => {
  it('maps known scopes to the right bits', () => {
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['models:read:self']).toBe(TokenScope.ModelsRead);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['ai:write:budgeted']).toBe(TokenScope.AIServicesWrite);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['block:settings:read']).toBe(0);
  });

  it('isKnownBlockScope rejects unknown strings', () => {
    expect(isKnownBlockScope('models:read:self')).toBe(true);
    expect(isKnownBlockScope('not:a:scope')).toBe(false);
  });

  describe('validateBlockScopesAgainstOauthClient', () => {
    it('passes when every requested scope has its bit', () => {
      const allowed = TokenScope.ModelsRead | TokenScope.MediaRead;
      const result = validateBlockScopesAgainstOauthClient(
        ['models:read:self', 'media:read:owned'],
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
      const result = validateBlockScopesAgainstOauthClient(['block:settings:read'], 0);
      expect(result.valid).toBe(true);
    });

    it('rejects unknown scopes outright', () => {
      const result = validateBlockScopesAgainstOauthClient(['not:a:scope'], TokenScope.Full);
      expect(result.valid).toBe(false);
      expect(result.rejectedScopes).toEqual(['not:a:scope']);
    });
  });
});
