import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit-test maybeUpgradeLegacySession's Set-Cookie assembly (the upgrade-on-read path). We stub ONLY the hub
// session-token client so we can drive exchangeLegacy; setSessionCookie, clearLegacyNextAuthCookies, and the
// cookie-name helpers stay REAL, so we assert the actual headers a legacy user's response would carry.
const h = vi.hoisted(() => ({ exchangeLegacy: vi.fn(), refresh: vi.fn(), revoke: vi.fn() }));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@civitai/auth')>();
  return {
    ...actual,
    createSessionTokenClient: () => ({
      exchangeLegacy: h.exchangeLegacy,
      refresh: h.refresh,
      revoke: h.revoke,
    }),
  };
});
// maybeUpgradeLegacySession never calls isRevoked — stub the module so the unit project doesn't pull in redis.
vi.mock('../session-verifier', () => ({ isRevoked: vi.fn() }));

// Minimal Set-Cookie-collecting response (the CookieWritable surface + a helper to read what landed).
function fakeRes() {
  let store: string | string[] | undefined;
  return {
    getHeader: (n: string) => (n.toLowerCase() === 'set-cookie' ? store : undefined),
    setHeader: (n: string, v: string | string[]) => {
      if (n.toLowerCase() === 'set-cookie') store = v;
    },
    cookies: () => (Array.isArray(store) ? store : store != null ? [String(store)] : []),
  };
}

describe('maybeUpgradeLegacySession — upgrade-on-read Set-Cookie assembly', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com'; // HUB_ORIGIN truthy + secure cookie naming
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const clears = (cookies: string[], name: string) =>
    cookies.some((c) => c.startsWith(`${name}=;`) && /Max-Age=0/i.test(c));

  it('on success sets the civ-token AND clears the legacy session + ancillary next-auth cookies', async () => {
    h.exchangeLegacy.mockResolvedValue({ token: 'fresh.civ.jwt' });
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', res, 'civitai.com');
    const cookies = res.cookies();

    expect(h.exchangeLegacy).toHaveBeenCalledWith('legacy.jwe');
    // (a) the freshly-minted civ-token lands (and the merge didn't drop it when appending the ancillary clears)
    expect(cookies.some((c) => c.includes('fresh.civ.jwt'))).toBe(true);
    // (b) the legacy SESSION cookie is cleared (via setSessionCookie -> clearLegacySessionCookies)
    expect(clears(cookies, '__Secure-civitai-token')).toBe(true);
    // (c) the ancillary next-auth cruft is cleared too
    expect(clears(cookies, '__Host-next-auth.csrf-token')).toBe(true);
    expect(clears(cookies, '__Secure-next-auth.callback-url')).toBe(true);
    expect(clears(cookies, '__Secure-next-auth.nonce')).toBe(true);
  });

  it('does nothing when the hub declines the exchange (no civ-token, no clears)', async () => {
    h.exchangeLegacy.mockResolvedValue(null);
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', res, 'civitai.com');
    expect(res.cookies()).toEqual([]);
  });

  it('no-ops without a legacy token (never calls the hub)', async () => {
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession(undefined, res, 'civitai.com');
    expect(h.exchangeLegacy).not.toHaveBeenCalled();
    expect(res.cookies()).toEqual([]);
  });

  it('no-ops when the hub origin is unconfigured (never calls the hub)', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    vi.resetModules();
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', res, 'civitai.com');
    expect(h.exchangeLegacy).not.toHaveBeenCalled();
  });

  it('is fire-safe: a rejecting exchange never throws and sets nothing', async () => {
    h.exchangeLegacy.mockRejectedValue(new Error('hub down'));
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await expect(
      maybeUpgradeLegacySession('legacy.jwe', res, 'civitai.com')
    ).resolves.toBeUndefined();
    expect(res.cookies().some((c) => c.includes('fresh'))).toBe(false);
  });
});
