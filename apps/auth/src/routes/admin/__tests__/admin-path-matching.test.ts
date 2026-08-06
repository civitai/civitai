import { describe, expect, it } from 'vitest';
import { decodePathname, isAdminPath, isAdminRequest } from '$lib/server/auth/admin';

/**
 * `decodePathname` exists to reproduce SvelteKit's `decode_pathname` exactly, because the guard's decision has
 * to agree with the router's. Nothing about "does this look like an admin path" can defend that: three wrong
 * rewrites of it (dropping the %25 hold-back, using decodeURIComponent, decoding twice) all leave the
 * admin/not-admin answer unchanged on most inputs. So the mirror is pinned on the STRING it returns.
 *
 * Expected values are the literal output SvelteKit produces, not a restatement of our implementation.
 */
describe('decodePathname mirrors SvelteKit route decoding', () => {
  it.each([
    ['leaves an already-decoded path alone', '/admin/x', '/admin/x'],
    ['decodes an escaped character once', '/%61dmin/x', '/admin/x'],
    ['holds %25 back rather than decoding it to a percent', '/%2561dmin/x', '/%2561dmin/x'],
    ['does not decode a reserved character', '/%2Fadmin/x', '/%2Fadmin/x'],
    ['does not decode a reserved character mid-path', '/admin%2Fx', '/admin%2Fx'],
    ['returns a malformed escape verbatim', '/admin/%zz', '/admin/%zz'],
    ['returns a bare percent verbatim', '/%', '/%'],
  ])('%s', (_label, input, expected) => {
    expect(decodePathname(input)).toBe(expected);
  });
});

describe('isAdminRequest', () => {
  // The security-critical direction: an escaped path that the router still delivers to an admin route must be
  // treated as one here. A guard that skipped decoding entirely would answer false for these.
  it.each([
    ['a plain admin path', '/admin/spoke-domains'],
    ['the admin root', '/admin'],
    ['an escaped admin path', '/%61dmin/spoke-domains'],
    ['an escaped character later in the segment', '/adm%69n/spoke-domains'],
    // Undecodable, so it never reaches a route — but it still reads as an admin path and is treated as one
    // rather than being handed onward on the strength of a decode failure.
    ['an admin path with a malformed escape', '/admin/%zz'],
  ])('treats %s as an admin request', (_label, pathname) => {
    expect(isAdminRequest(pathname, null)).toBe(true);
  });

  it.each([
    ['a doubly-escaped path, which the router does not resolve to /admin', '/%2561dmin/x'],
    ['an escaped slash, which is not a path separator to the router', '/%2Fadmin/x'],
    ['a path that merely starts with the same letters', '/administrators'],
    ['an unrelated path', '/login'],
    ['the site root', '/'],
  ])('does not treat %s as an admin request', (_label, pathname) => {
    expect(isAdminRequest(pathname, null)).toBe(false);
  });

  it('treats a request routed to an admin route as one whatever the path looks like', () => {
    expect(isAdminRequest('/somewhere-else', '/admin/spoke-domains')).toBe(true);
    expect(isAdminRequest('/somewhere-else', '/admin/roles/[role]')).toBe(true);
  });

  it('does not treat a request routed elsewhere as an admin request', () => {
    expect(isAdminRequest('/login', '/login')).toBe(false);
    expect(isAdminRequest('/login', null)).toBe(false);
    expect(isAdminRequest('/login', undefined)).toBe(false);
  });
});

describe('isAdminPath', () => {
  it('matches the admin area and paths under it, and nothing that merely looks like one', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/')).toBe(true);
    expect(isAdminPath('/admin/roles/x/__data.json')).toBe(true);
    expect(isAdminPath('/administrators')).toBe(false);
    expect(isAdminPath('/adm')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
    expect(isAdminPath('')).toBe(false);
  });
});
