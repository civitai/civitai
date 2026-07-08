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

  it('rejects look-alike hosts that merely CONTAIN "civitai" (substring-bypass guard)', () => {
    // Each contains the substring "civitai" but is NOT a civitai eTLD+1 — must collapse to '/'.
    expect(buildPostLoginRedirect('https://civitai.evil.com/x', null, ORIGIN, false)).toBe('/');
    expect(buildPostLoginRedirect('https://evil-civitai.com/x', null, ORIGIN, false)).toBe('/');
    expect(buildPostLoginRedirect('https://civitai.com.attacker.io/x', null, ORIGIN, false)).toBe('/');
    expect(buildPostLoginRedirect('https://notcivitai.red/x', null, ORIGIN, false)).toBe('/');
    expect(buildPostLoginRedirect('https://xcivitai.com/x', null, ORIGIN, false)).toBe('/');
  });

  it('rejects host-confusion / parser-trick origins (must collapse to /)', () => {
    // userinfo: the real host is evil.com — `civitai.com@` is credentials, stripped by .origin parsing.
    expect(buildPostLoginRedirect('https://civitai.com@evil.com/x', null, ORIGIN, false)).toBe('/');
    expect(buildPostLoginRedirect('https://civitai.com:443@evil.com/x', null, ORIGIN, false)).toBe(
      '/'
    );
    // trailing-dot FQDN form of a civitai host — not in the allowlist, denied (safe direction).
    expect(buildPostLoginRedirect('https://civitai.com./x', null, ORIGIN, false)).toBe('/');
    // suffix-confusion: civitai.red as a subdomain label of an attacker domain.
    expect(buildPostLoginRedirect('https://civitai.red.evil.com/x', null, ORIGIN, false)).toBe('/');
    // IDN / Cyrillic homoglyph "сivitai.com" (leading char is U+0441) punycodes to a non-civitai host.
    expect(buildPostLoginRedirect('https://сivitai.com/x', null, ORIGIN, false)).toBe('/');
    // opaque-origin schemes (javascript:, data:) yield origin "null" → denied.
    expect(buildPostLoginRedirect('javascript:alert(1)//civitai.com', null, ORIGIN, false)).toBe(
      '/'
    );
    expect(buildPostLoginRedirect('data:text/html,civitai.com', null, ORIGIN, false)).toBe('/');
    // malformed / non-URL target → URL() throws → not a safe absolute target → '/'.
    expect(buildPostLoginRedirect('http://', null, ORIGIN, false)).toBe('/');
    // IPv6 literal path that merely contains the string civitai.com.
    expect(buildPostLoginRedirect('https://[::1]/civitai.com', null, ORIGIN, false)).toBe('/');
  });

  it('accepts genuine civitai hosts regardless of case / percent-encoded host', () => {
    // The host check is case-insensitive (uppercase host still matches), and the original target
    // string is returned verbatim — the allowlist normalizes for comparison, it does not rewrite.
    expect(buildPostLoginRedirect('https://CIVITAI.COM/x', null, ORIGIN, false)).toBe(
      'https://CIVITAI.COM/x'
    );
    // percent-encoded host that decodes to the genuine host is treated as the genuine host.
    expect(buildPostLoginRedirect('https://%63ivitai.com/x', null, ORIGIN, false)).toBe(
      'https://%63ivitai.com/x'
    );
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
