import { describe, it, expect, beforeEach, vi } from 'vitest';

// The e2e-only `stub` provider (providers.ts) must be PROD-INERT: it enables ONLY when
// AUTH_ENABLE_STUB_PROVIDER is truthy AND its STUB_CLIENT_ID/SECRET are set. These tests pin that gate
// (a stray STUB_* env must NOT light up a stub login on prod), its env-driven URLs, and its profile mapping.
//
// providers.ts reads STUB_*_URL at MODULE LOAD (the PROVIDERS object literal), so we set env BEFORE a fresh
// dynamic import via `vi.resetModules()`. The env mock (src/test/env.mock.ts) backs $env/dynamic/private with
// process.env, so we drive everything through process.env.

const STUB_KEYS = [
  'AUTH_ENABLE_STUB_PROVIDER',
  'STUB_AUTHORIZE_URL',
  'STUB_TOKEN_URL',
  'STUB_USERINFO_URL',
  'STUB_CLIENT_ID',
  'STUB_CLIENT_SECRET',
] as const;

const FULL = {
  AUTH_ENABLE_STUB_PROVIDER: '1',
  STUB_AUTHORIZE_URL: 'http://stub-oidc.test/authorize',
  STUB_TOKEN_URL: 'http://stub-oidc.test/token',
  STUB_USERINFO_URL: 'http://stub-oidc.test/userinfo',
  STUB_CLIENT_ID: 'stub-client',
  STUB_CLIENT_SECRET: 'stub-secret',
};

async function load(env: Partial<typeof FULL>) {
  vi.resetModules();
  for (const k of STUB_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return import('../providers');
}

beforeEach(() => {
  for (const k of STUB_KEYS) delete process.env[k];
});

describe('stub provider — prod-inertness gate', () => {
  it('is DISABLED by default even when STUB creds are set but the flag is unset (prod-inert)', async () => {
    const p = await load({
      STUB_CLIENT_ID: 'stub-client',
      STUB_CLIENT_SECRET: 'stub-secret',
      // no AUTH_ENABLE_STUB_PROVIDER
    });
    expect(p.isStubProviderEnabled()).toBe(false);
    expect(p.listEnabledProviders().map((x) => x.id)).not.toContain('stub');
  });

  it('stays DISABLED when the flag is set but client creds are missing', async () => {
    const p = await load({ AUTH_ENABLE_STUB_PROVIDER: '1' });
    expect(p.isStubProviderEnabled()).toBe(true); // the flag itself is on...
    expect(p.listEnabledProviders().map((x) => x.id)).not.toContain('stub'); // ...but no creds → not listed
  });

  it('ENABLES only when the flag is truthy AND creds are set', async () => {
    const p = await load(FULL);
    expect(p.isStubProviderEnabled()).toBe(true);
    expect(p.listEnabledProviders().map((x) => x.id)).toContain('stub');
  });

  it('treats only 1/true/yes/on (case-insensitive) as truthy for the flag', async () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      const p = await load({ ...FULL, AUTH_ENABLE_STUB_PROVIDER: v });
      expect(p.isStubProviderEnabled(), `"${v}" should be falsy`).toBe(false);
    }
    for (const v of ['1', 'true', 'TRUE', 'Yes', 'on']) {
      const p = await load({ ...FULL, AUTH_ENABLE_STUB_PROVIDER: v });
      expect(p.isStubProviderEnabled(), `"${v}" should be truthy`).toBe(true);
    }
  });
});

describe('stub provider — wiring', () => {
  it('reads its authorize/token/userinfo URLs + creds from STUB_* env', async () => {
    const p = await load(FULL);
    const stub = p.getProvider('stub');
    expect(stub).toBeDefined();
    expect(stub!.authorizeUrl).toBe(FULL.STUB_AUTHORIZE_URL);
    expect(stub!.tokenUrl).toBe(FULL.STUB_TOKEN_URL);
    expect(stub!.userinfoUrl).toBe(FULL.STUB_USERINFO_URL);
    expect(stub!.clientId()).toBe(FULL.STUB_CLIENT_ID);
    expect(stub!.clientSecret()).toBe(FULL.STUB_CLIENT_SECRET);
    expect(stub!.scope).toContain('openid');
  });

  it('maps the stub-oidc-server STUB_PROFILE shape onto the normalized profile', async () => {
    const p = await load(FULL);
    const stub = p.getProvider('stub')!;
    // Mirrors stub-oidc-server.mjs STUB_PROFILE: { sub|id, email, email_verified, name, preferred_username }.
    const mapped = stub.mapProfile({
      sub: 'stub-user-42',
      email: 'ci-smoke-tester@civitai.test',
      email_verified: true,
      name: 'CI Smoke Tester',
      preferred_username: 'ci-smoke-tester',
    });
    expect(mapped.providerAccountId).toBe('stub-user-42');
    expect(mapped.email).toBe('ci-smoke-tester@civitai.test');
    expect(mapped.emailVerified).toBe(true);
    expect(mapped.username).toBe('ci-smoke-tester');
    expect(mapped.name).toBe('CI Smoke Tester');
  });

  it('falls back to `id` when the profile has no `sub`', async () => {
    const p = await load(FULL);
    const mapped = p.getProvider('stub')!.mapProfile({ id: 7, email: 'x@y.z' });
    expect(mapped.providerAccountId).toBe('7');
  });
});
