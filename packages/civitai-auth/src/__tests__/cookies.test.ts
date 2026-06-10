import { describe, it, expect } from 'vitest';
import { cookiePrefix, sessionCookieName } from '../cookies';

describe('cookies', () => {
  it('prefixes secure cookies with __Secure-', () => {
    expect(cookiePrefix(true)).toBe('__Secure-');
    expect(cookiePrefix(false)).toBe('');
  });

  it('builds the session cookie name (matches main app libs/auth.ts)', () => {
    expect(sessionCookieName(true)).toBe('__Secure-civitai-token');
    expect(sessionCookieName(false)).toBe('civitai-token');
  });
});
