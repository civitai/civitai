import { describe, expect, it } from 'vitest';
import {
  APP_BLOCK_OAUTH_CLIENT_ID_PREFIX,
  BLOCK_SCOPE_TO_OAUTH_BIT,
  deriveOauthBitmaskFromBlockScopes,
  isAppBlockOauthClientId,
  isKnownBlockScope,
  SKIP_OAUTH_CHECK,
  validateBlockScopesAgainstOauthClient,
} from '../block-scope.constants';
import { TokenScope } from '../token-scope.constants';

describe('block-scope.constants', () => {
  it('maps known scopes to the right bits', () => {
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['models:read:self']).toBe(TokenScope.ModelsRead);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['ai:write:budgeted']).toBe(TokenScope.AIServicesWrite);
    // settings + storage scopes intentionally have no OAuth bit (SKIP sentinel).
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['block:settings:read']).toBe(SKIP_OAUTH_CHECK);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['apps:storage:read']).toBe(SKIP_OAUTH_CHECK);
    expect(BLOCK_SCOPE_TO_OAUTH_BIT['apps:storage:write']).toBe(SKIP_OAUTH_CHECK);
  });

  it('apps:storage:* are now declarable (known) scopes', () => {
    // Fix 3 / audit A5: storage was previously unknown, so a manifest couldn't
    // even list it and resolveStorageContext never gated on it (ambient cap).
    expect(isKnownBlockScope('apps:storage:read')).toBe(true);
    expect(isKnownBlockScope('apps:storage:write')).toBe(true);
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
      // block:settings:* + apps:storage:* are gated elsewhere, not via the bit.
      expect(
        deriveOauthBitmaskFromBlockScopes([
          'block:settings:read',
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
