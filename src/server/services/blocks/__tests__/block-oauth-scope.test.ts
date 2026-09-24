import { describe, expect, it } from 'vitest';
import {
  isConsentRequiredError,
  manifestWantsOauthToken,
  oauthScopeBitsFor,
} from '~/server/services/blocks/block-oauth-scope';
import { TokenScope } from '~/shared/constants/token-scope.constants';

describe('oauthScopeBitsFor', () => {
  it('maps block scopes to their OAuth bits and always adds UserRead', () => {
    expect(oauthScopeBitsFor([])).toBe(TokenScope.UserRead);
    expect(oauthScopeBitsFor(['models:read:self', 'ai:write:budgeted'])).toBe(
      TokenScope.UserRead | TokenScope.ModelsRead | TokenScope.AIServicesWrite
    );
  });

  it('ignores block-only and unknown scopes', () => {
    expect(
      oauthScopeBitsFor(['apps:storage:read', 'apps:storage:write', 'not:a:scope', '__proto__'])
    ).toBe(TokenScope.UserRead);
  });
});

describe('manifestWantsOauthToken', () => {
  it('is true only for an explicit auth: "oauth"', () => {
    expect(manifestWantsOauthToken({ auth: 'oauth' })).toBe(true);
    expect(manifestWantsOauthToken({ auth: 'block-token' })).toBe(false);
    expect(manifestWantsOauthToken({})).toBe(false);
    expect(manifestWantsOauthToken(null)).toBe(false);
  });
});

describe('isConsentRequiredError', () => {
  it('recognises the hub refusal in its code, error and message spellings', () => {
    expect(
      isConsentRequiredError(Object.assign(new Error('x'), { code: 'consent_required' }))
    ).toBe(true);
    expect(isConsentRequiredError(new Error('hub 403: consent_required'))).toBe(false);
    expect(isConsentRequiredError(new Error('client_disabled'))).toBe(false);
    expect(isConsentRequiredError(undefined)).toBe(false);
  });
});
