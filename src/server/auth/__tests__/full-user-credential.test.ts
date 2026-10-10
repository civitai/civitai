import { describe, expect, it } from 'vitest';
import { isFullScopeUserKey } from '~/server/auth/full-user-credential';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const REDUCED = TokenScope.Full & ~TokenScope.UserRead;
const personal = {
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 1 },
  tokenScope: TokenScope.Full,
} as const;

describe('isFullScopeUserKey', () => {
  it('accepts a full-scope personal API key', () => {
    expect(isFullScopeUserKey(personal)).toBe(true);
  });

  it.each(['System', 'Access', 'Refresh', 'SomethingNew'] as const)(
    'refuses a full-scope %s key',
    (apiKeyType) => {
      expect(isFullScopeUserKey({ ...personal, apiKeyType: apiKeyType as never })).toBe(false);
    }
  );

  it('refuses a key whose type is missing', () => {
    expect(isFullScopeUserKey({ ...personal, apiKeyType: undefined })).toBe(false);
    expect(isFullScopeUserKey({ ...personal, apiKeyType: null })).toBe(false);
  });

  it('refuses a User key carrying an OAuth subject', () => {
    expect(isFullScopeUserKey({ ...personal, subject: { type: 'oauth', id: 'c' } })).toBe(false);
  });

  it('refuses a reduced-scope personal key', () => {
    expect(isFullScopeUserKey({ ...personal, tokenScope: REDUCED })).toBe(false);
  });

  it('refuses a key carrying an opt-in bit outside Full', () => {
    expect(
      isFullScopeUserKey({ ...personal, tokenScope: TokenScope.Full | TokenScope.AppBlocksSubmit })
    ).toBe(false);
  });

  it('refuses no credential at all', () => {
    expect(isFullScopeUserKey(undefined)).toBe(false);
    expect(isFullScopeUserKey(null)).toBe(false);
  });
});
