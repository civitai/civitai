import { describe, it, expect } from 'vitest';
import { ALL_SCOPES, TokenScope } from '@civitai/auth/token-scope';
import { parseScopeRequest, SUPPORTED_SCOPE_NAMES } from '../scope';

describe('parseScopeRequest', () => {
  it('reads the decimal bitmask', () => {
    expect(parseScopeRequest('5')).toEqual({ scope: 5n, openid: false, offlineAccess: false });
  });

  it('reads TokenScope names, ORed together', () => {
    expect(parseScopeRequest('ModelsRead MediaRead')).toEqual({
      scope: TokenScope.ModelsRead | TokenScope.MediaRead,
      openid: false,
      offlineAccess: false,
    });
  });

  it('reads OIDC scopes: openid and offline_access as flags, profile and email as UserRead', () => {
    expect(parseScopeRequest('openid profile email offline_access')).toEqual({
      scope: TokenScope.UserRead,
      openid: true,
      offlineAccess: true,
    });
    expect(parseScopeRequest('offline_access')).toEqual({
      scope: 0n,
      openid: false,
      offlineAccess: true,
    });
  });

  it('reads the Apps scopes by name and as a bitmask past bit 30', () => {
    expect(parseScopeRequest('AppsRead AppDataRead')).toEqual({
      scope: 6442450944n,
      openid: false,
      offlineAccess: false,
    });
    expect(parseScopeRequest('6442450945')).toEqual({
      scope: 6442450945n,
      openid: false,
      offlineAccess: false,
    });
  });

  it('mixes names and numbers, and tolerates extra whitespace', () => {
    expect(parseScopeRequest('  openid   4 MediaRead ')).toEqual({
      scope: TokenScope.ModelsRead | TokenScope.MediaRead,
      openid: true,
      offlineAccess: false,
    });
  });

  it('treats missing or blank as no permissions', () => {
    expect(parseScopeRequest(undefined)).toEqual({
      scope: 0n,
      openid: false,
      offlineAccess: false,
    });
    expect(parseScopeRequest('')).toEqual({ scope: 0n, openid: false, offlineAccess: false });
  });

  it('refuses unknown names, `None`, negatives and values beyond ALL_SCOPES', () => {
    expect(parseScopeRequest('ModelsRead Bogus')).toBeNull();
    expect(parseScopeRequest('None')).toBeNull();
    expect(parseScopeRequest('-1')).toBeNull();
    expect(parseScopeRequest(String(ALL_SCOPES + 1n))).toBeNull();
    expect(parseScopeRequest('toString')).toBeNull();
  });

  it('refuses RunnerMint by name and as a bitmask, and does not advertise it', () => {
    expect(parseScopeRequest('RunnerMint')).toBeNull();
    expect(parseScopeRequest('UserRead RunnerMint')).toBeNull();
    expect(parseScopeRequest(String(TokenScope.RunnerMint | TokenScope.UserRead))).toBeNull();
    expect(SUPPORTED_SCOPE_NAMES).not.toContain('RunnerMint');
  });

  it('accepts every name it advertises', () => {
    for (const name of SUPPORTED_SCOPE_NAMES) expect(parseScopeRequest(name)).not.toBeNull();
  });
});
