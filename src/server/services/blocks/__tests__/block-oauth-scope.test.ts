import { describe, expect, it } from 'vitest';
import {
  isConsentRequiredError,
  manifestCanMintOauthToken,
  manifestWantsOauthToken,
  OAUTH_BASELINE_BLOCK_SCOPE,
  oauthScopeBitsFor,
} from '~/server/services/blocks/block-oauth-scope';
import { BLOCK_SCOPE_TO_OAUTH_BIT } from '~/shared/constants/block-scope.constants';
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

describe('OAUTH_BASELINE_BLOCK_SCOPE', () => {
  /**
   * 🔴 DRIFT GUARD (#5127). One fact, two spellings: the consent mirror refuses on the
   * BIT (`… & TokenScope.UserRead`, which is what the hub compares), this module
   * refuses on the SCOPE NAME (which is what a manifest declares). If the mapping ever
   * moved `user:read:self` onto a different bit, the two checks would disagree and a
   * manifest could pass the declaration gate while the mirror still withheld the bit —
   * back to a block stuck in the consent loop. Pinned as the equality, not as either
   * literal.
   */
  it('names the block scope that carries TokenScope.UserRead', () => {
    expect(BLOCK_SCOPE_TO_OAUTH_BIT[OAUTH_BASELINE_BLOCK_SCOPE]).toBe(TokenScope.UserRead);
    expect(oauthScopeBitsFor([OAUTH_BASELINE_BLOCK_SCOPE]) & TokenScope.UserRead).not.toBe(0);
  });
});

describe('manifestCanMintOauthToken', () => {
  it('requires auth: "oauth" AND a declared user:read:self', () => {
    expect(manifestCanMintOauthToken({ auth: 'oauth' }, ['user:read:self'])).toBe(true);
    expect(
      manifestCanMintOauthToken({ auth: 'oauth' }, ['models:read:self', 'user:read:self'])
    ).toBe(true);
    // Declares the baseline but does not ask for an OAuth token at all.
    expect(manifestCanMintOauthToken({ auth: 'block-token' }, ['user:read:self'])).toBe(false);
    expect(manifestCanMintOauthToken({}, ['user:read:self'])).toBe(false);
    // 🔴 The F1 case: wants an OAuth token, never declared the baseline it must carry.
    expect(manifestCanMintOauthToken({ auth: 'oauth' }, ['models:read:self'])).toBe(false);
    expect(manifestCanMintOauthToken({ auth: 'oauth' }, [])).toBe(false);
  });

  it('reads the declared list rather than a prefix or substring of it', () => {
    expect(manifestCanMintOauthToken({ auth: 'oauth' }, ['user:read:self:extra'])).toBe(false);
    expect(manifestCanMintOauthToken({ auth: 'oauth' }, ['user:read'])).toBe(false);
  });
});
