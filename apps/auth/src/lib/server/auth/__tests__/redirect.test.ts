import { describe, it, expect } from 'vitest';
import { buildPostLoginRedirect } from '../redirect';

// The hub wrapper bakes in the civitai-origin policy (`origin.includes('civitai')`) and maps the
// `dev` flag → allowAllOrigins. The base contract (returnUrl/sync re-attach) is tested in the
// package's redirect.test.ts; this asserts the hub's allow/deny ORIGIN matrix + dev bypass.
const ORIGIN = 'https://auth.civitai.com';

describe('buildPostLoginRedirect (hub civitai-origin policy)', () => {
  it('passes a same-origin relative target through unchanged', () => {
    expect(buildPostLoginRedirect('/dashboard', null, ORIGIN, false)).toBe('/dashboard');
  });

  it('allows an absolute target on a civitai-* origin', () => {
    expect(buildPostLoginRedirect('https://civitai.com/models', null, ORIGIN, false)).toBe(
      'https://civitai.com/models'
    );
    expect(buildPostLoginRedirect('https://civitai.red/x', null, ORIGIN, false)).toBe(
      'https://civitai.red/x'
    );
    expect(buildPostLoginRedirect('https://moderator.civitai.com/y', null, ORIGIN, false)).toBe(
      'https://moderator.civitai.com/y'
    );
  });

  it('collapses a non-civitai absolute target to / (open-redirect guard)', () => {
    expect(buildPostLoginRedirect('https://evil.com/phish', null, ORIGIN, false)).toBe('/');
  });

  it('collapses a protocol-relative target to /', () => {
    expect(buildPostLoginRedirect('//evil.com', null, ORIGIN, false)).toBe('/');
  });

  it('dev=true bypasses the origin allowlist (allowAllOrigins)', () => {
    expect(buildPostLoginRedirect('http://localhost:3000/x', null, ORIGIN, true)).toBe(
      'http://localhost:3000/x'
    );
    // even an otherwise-denied origin is allowed in dev
    expect(buildPostLoginRedirect('https://evil.com/x', null, ORIGIN, true)).toBe(
      'https://evil.com/x'
    );
  });

  it('re-attaches sync as sync-account on an allowed target', () => {
    expect(buildPostLoginRedirect('/dashboard', 'green', ORIGIN, false)).toBe(
      '/dashboard?sync-account=green'
    );
    expect(buildPostLoginRedirect('https://civitai.com/x', 'blue', ORIGIN, false)).toBe(
      'https://civitai.com/x?sync-account=blue'
    );
  });

  it('does not re-attach sync onto a target that was rejected to /', () => {
    // denied origin collapses to '/', and sync is re-attached to that safe target
    expect(buildPostLoginRedirect('https://evil.com', 'green', ORIGIN, false)).toBe(
      '/?sync-account=green'
    );
  });
});
