import { describe, it, expect } from 'vitest';
import { cookiePrefix, sessionCookieName, legacySessionCookieName } from '../cookies';

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
