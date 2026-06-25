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
  return { calls, cookies, find: (name: string) => calls.find((c) => c.name === name) };
}

describe('clearLegacyCookies (hub)', () => {
  beforeEach(() => {
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  });

  it('clears the legacy SESSION cookie (both prefixes) over the registrable domain', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    expect(r.find('__Secure-civitai-token')?.opts).toMatchObject({
      domain: 'civitai.com',
      secure: true,
    });
    expect(r.find('civitai-token')?.opts).toMatchObject({ domain: 'civitai.com', secure: false });
  });

  it('clears the __Host- CSRF cookie host-only (no Domain) with secure; the bare one host-only non-secure', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    const host = r.find('__Host-next-auth.csrf-token');
    expect(host?.opts.domain).toBeUndefined();
    expect(host?.opts.secure).toBe(true);
    expect(r.find('next-auth.csrf-token')?.opts.domain).toBeUndefined();
  });

  it('de-cruds the ancillary next-auth cookies over the registrable domain', () => {
    const r = recorder();
    clearLegacyCookies(r.cookies);
    for (const name of [
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.pkce.code_verifier',
      '__Secure-next-auth.nonce',
    ]) {
      expect(r.find(name)?.opts.domain).toBe('civitai.com');
    }
  });

  it('prefers NEXTAUTH_COOKIE_DOMAIN over the registrable domain when set', () => {
    process.env.NEXTAUTH_COOKIE_DOMAIN = '.civitai.com';
    const r = recorder();
    clearLegacyCookies(r.cookies);
    expect(r.find('__Secure-civitai-token')?.opts.domain).toBe('.civitai.com');
  });
});
