import { describe, it, expect } from 'vitest';
import { ALL_SCOPES, TokenScope } from '@civitai/auth/token-scope';
import { parseScopeRequest, SUPPORTED_SCOPE_NAMES } from '../scope';

describe('parseScopeRequest', () => {
  it('reads the decimal bitmask', () => {
    expect(parseScopeRequest('5')).toEqual({ scope: 5, openid: false });
  });

  it('reads TokenScope names, ORed together', () => {
    expect(parseScopeRequest('ModelsRead MediaRead')).toEqual({
      scope: TokenScope.ModelsRead | TokenScope.MediaRead,
      openid: false,
    });
  });

  it('reads OIDC scopes: openid as a flag, profile and email as UserRead, offline_access as nothing', () => {
    expect(parseScopeRequest('openid profile email offline_access')).toEqual({
      scope: TokenScope.UserRead,
      openid: true,
    });
  });

  it('mixes names and numbers, and tolerates extra whitespace', () => {
    expect(parseScopeRequest('  openid   4 MediaRead ')).toEqual({
      scope: TokenScope.ModelsRead | TokenScope.MediaRead,
      openid: true,
    });
  });

  it('treats missing or blank as no permissions', () => {
    expect(parseScopeRequest(undefined)).toEqual({ scope: 0, openid: false });
    expect(parseScopeRequest('')).toEqual({ scope: 0, openid: false });
  });

  it('refuses unknown names, `None`, negatives and values beyond ALL_SCOPES', () => {
    expect(parseScopeRequest('ModelsRead Bogus')).toBeNull();
    expect(parseScopeRequest('None')).toBeNull();
    expect(parseScopeRequest('-1')).toBeNull();
    expect(parseScopeRequest(String(ALL_SCOPES + 1))).toBeNull();
    expect(parseScopeRequest('toString')).toBeNull();
  });

  it('accepts every name it advertises', () => {
    for (const name of SUPPORTED_SCOPE_NAMES) expect(parseScopeRequest(name)).not.toBeNull();
  });
});
