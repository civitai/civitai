import { describe, it, expect, beforeEach } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

// cookieDomain() is the registrable-domain helper; pin it so the test asserts the clear scope deterministically.
import { vi } from 'vitest';
vi.mock('../cookie', () => ({ cookieDomain: () => 'civitai.com' }));

import { clearLegacyCookies } from '../legacy-cookies';

type DeleteOpts = { path: string; secure?: boolean; domain?: string };
function recorder() {
  const calls: { name: string; opts: DeleteOpts }[] = [];
  const cookies = {
    delete: (name: string, opts: DeleteOpts) => calls.push({ name, opts }),
  } as unknown as Cookies;
  return {
    calls,
    cookies,
    find: (name: string) => calls.find((c) => c.name === name),
    findAll: (name: string) => calls.filter((c) => c.name === name),
    domainsFor: (name: string) => calls.filter((c) => c.name === name).map((c) => c.opts.domain),
  };
}

describe('clearLegacyCookies (hub)', () => {
  beforeEach(() => {
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  });

  it('clears the legacy SESSION cookie (both prefixes) host-only AND Domain-scoped', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    // The host-only clear (domain undefined) is the security-critical one: a Domain-scoped delete can't
    // remove a host-only legacy cookie of the same name, and a surviving one silently re-authenticates the
    // user after logout. Both scopes must be emitted for each prefix.
    expect(r.domainsFor('__Secure-civitai-token')).toEqual(
      expect.arrayContaining([undefined, 'civitai.com'])
    );
    expect(r.domainsFor('civitai-token')).toEqual(
      expect.arrayContaining([undefined, 'civitai.com'])
    );
    expect(r.find('__Secure-civitai-token')?.opts.secure).toBe(true);
    expect(r.find('civitai-token')?.opts.secure).toBe(false);
  });

  it('clears the __Host- CSRF cookie host-only (no Domain) with secure; the bare one host-only non-secure', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    // The CSRF cookies are host-only ONLY (the `__Host-` prefix forbids a Domain attribute) — a single call each.
    const host = r.findAll('__Host-next-auth.csrf-token');
    expect(host).toHaveLength(1);
    expect(host[0].opts.domain).toBeUndefined();
    expect(host[0].opts.secure).toBe(true);
    const bare = r.findAll('next-auth.csrf-token');
    expect(bare).toHaveLength(1);
    expect(bare[0].opts.domain).toBeUndefined();
  });

  it('de-cruds the ancillary next-auth cookies host-only AND over the registrable domain', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    for (const name of [
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.pkce.code_verifier',
      '__Secure-next-auth.nonce',
    ]) {
      expect(r.domainsFor(name)).toEqual(expect.arrayContaining([undefined, 'civitai.com']));
    }
  });

  it('clears the session cookie across host-only, NEXTAUTH_COOKIE_DOMAIN, AND the registrable domain', () => {
    process.env.NEXTAUTH_COOKIE_DOMAIN = '.civitai.com';
    const r = recorder();
    clearLegacyCookies(r.cookies);
    // Every scope the cookie could have been set on is cleared — host-only, the explicit override, and the
    // registrable domain (deduped).
    expect(r.domainsFor('__Secure-civitai-token')).toEqual(
      expect.arrayContaining([undefined, '.civitai.com', 'civitai.com'])
    );
  });
});
