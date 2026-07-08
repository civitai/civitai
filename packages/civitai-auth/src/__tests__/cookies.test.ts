import { describe, it, expect, afterEach } from 'vitest';
import {
  cookiePrefix,
  sessionCookieName,
  legacySessionCookieName,
  isSecureCookie,
} from '../cookies';

describe('cookies', () => {
  it('prefixes secure cookies with __Secure-', () => {
    expect(cookiePrefix(true)).toBe('__Secure-');
    expect(cookiePrefix(false)).toBe('');
  });

  it('builds the session cookie name (matches main app libs/auth.ts)', () => {
    expect(sessionCookieName(true)).toBe('__Secure-civ-token');
    expect(sessionCookieName(false)).toBe('civ-token');
  });

  it('builds the legacy next-auth cookie name with the same dev/prod secure logic', () => {
    expect(legacySessionCookieName(true)).toBe('__Secure-civitai-token');
    expect(legacySessionCookieName(false)).toBe('civitai-token');
  });
});

describe('isSecureCookie (env-derived)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('true when the app serves https via NEXT_PUBLIC_BASE_URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://civitai.com';
    expect(isSecureCookie()).toBe(true);
  });

  it('falls through to AUTH_JWT_ISSUER when NEXT_PUBLIC_BASE_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    expect(isSecureCookie()).toBe(true);
  });

  // Regression: `??` would pin to '' here (non-secure → wrong cookie name); `||` falls through.
  it('falls through to AUTH_JWT_ISSUER when NEXT_PUBLIC_BASE_URL is EMPTY-string', () => {
    process.env.NEXT_PUBLIC_BASE_URL = '';
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com';
    expect(isSecureCookie()).toBe(true);
  });

  it('false for an http (localhost) app', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
    expect(isSecureCookie()).toBe(false);
  });
});
