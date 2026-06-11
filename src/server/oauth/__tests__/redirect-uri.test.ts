import { describe, it, expect } from 'vitest';
import {
  isAllowedDcrRedirectUri,
  redirectUriMatches,
  isRegisteredRedirectUri,
} from '~/server/oauth/redirect-uri';

describe('isAllowedDcrRedirectUri — RFC 7591 DCR allowlist', () => {
  it('accepts https URLs on any host', () => {
    expect(isAllowedDcrRedirectUri('https://app.example.com/callback')).toBe(true);
    expect(isAllowedDcrRedirectUri('https://example.com')).toBe(true);
    expect(isAllowedDcrRedirectUri('https://sub.domain.io/a/b?x=1')).toBe(true);
  });

  it('accepts http loopback addresses (any port)', () => {
    expect(isAllowedDcrRedirectUri('http://127.0.0.1/cb')).toBe(true);
    expect(isAllowedDcrRedirectUri('http://127.0.0.1:8723/cb')).toBe(true);
    expect(isAllowedDcrRedirectUri('http://[::1]:54321/callback')).toBe(true);
    expect(isAllowedDcrRedirectUri('http://localhost:3000/oauth')).toBe(true);
    expect(isAllowedDcrRedirectUri('http://localhost/oauth')).toBe(true);
  });

  it('rejects non-loopback http', () => {
    expect(isAllowedDcrRedirectUri('http://app.example.com/cb')).toBe(false);
    expect(isAllowedDcrRedirectUri('http://192.168.1.5/cb')).toBe(false);
    expect(isAllowedDcrRedirectUri('http://example.com')).toBe(false);
  });

  it('rejects custom schemes and OOB', () => {
    expect(isAllowedDcrRedirectUri('myapp://callback')).toBe(false);
    expect(isAllowedDcrRedirectUri('com.example.app:/oauth')).toBe(false);
    expect(isAllowedDcrRedirectUri('urn:ietf:wg:oauth:2.0:oob')).toBe(false);
    expect(isAllowedDcrRedirectUri('data:text/html,evil')).toBe(false);
    expect(isAllowedDcrRedirectUri('javascript:alert(1)')).toBe(false);
  });

  it('rejects garbage and fragment-bearing URIs', () => {
    expect(isAllowedDcrRedirectUri('not a url')).toBe(false);
    expect(isAllowedDcrRedirectUri('')).toBe(false);
    expect(isAllowedDcrRedirectUri('https://example.com/cb#frag')).toBe(false);
  });
});

describe('redirectUriMatches — loopback-aware /authorize matching', () => {
  it('matches loopback ignoring the port', () => {
    expect(redirectUriMatches('http://127.0.0.1:54213/cb', 'http://127.0.0.1:8080/cb')).toBe(true);
    expect(redirectUriMatches('http://localhost:9999/cb', 'http://localhost/cb')).toBe(true);
    expect(redirectUriMatches('http://[::1]:1/cb', 'http://[::1]:2/cb')).toBe(true);
  });

  it('does not match loopback when the path differs', () => {
    expect(redirectUriMatches('http://127.0.0.1:1/cb', 'http://127.0.0.1:2/other')).toBe(false);
  });

  it('does not match loopback when the scheme differs', () => {
    expect(redirectUriMatches('https://localhost/cb', 'http://localhost/cb')).toBe(false);
  });

  it('requires exact match for non-loopback hosts', () => {
    expect(redirectUriMatches('https://app.example.com/cb', 'https://app.example.com/cb')).toBe(
      true
    );
    expect(
      redirectUriMatches('https://app.example.com:8443/cb', 'https://app.example.com/cb')
    ).toBe(false);
  });

  it('isRegisteredRedirectUri matches against any registered URI', () => {
    const registered = ['https://a.com/cb', 'http://127.0.0.1:1/cb'];
    expect(isRegisteredRedirectUri('http://127.0.0.1:5000/cb', registered)).toBe(true);
    expect(isRegisteredRedirectUri('https://a.com/cb', registered)).toBe(true);
    expect(isRegisteredRedirectUri('https://evil.com/cb', registered)).toBe(false);
  });
});
