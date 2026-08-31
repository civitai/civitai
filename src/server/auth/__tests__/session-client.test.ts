import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';

// Unit-test maybeUpgradeLegacySession's Set-Cookie assembly (the upgrade-on-read path). We stub ONLY the hub
// session-token client so we can drive exchangeLegacy; setSessionCookie, clearLegacyCookies, and the
// cookie-name helpers stay REAL, so we assert the actual headers a legacy user's response would carry.
const h = vi.hoisted(() => ({
  exchangeLegacy: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  redisSet: vi.fn(),
}));
// Hand-listed rather than spread-from-original (matching session-invalidation.test.ts): importOriginal here
// would construct the real redis clients at module load. Only the upgrade dedupe's SET NX is exercised.
vi.mock('~/server/redis/client', () => ({
  sysRedis: { set: h.redisSet },
  REDIS_SYS_KEYS: { SESSION: { LEGACY_UPGRADE_LOCK: 'session:legacy-upgrade-lock' } },
  withSysReadDeadline: (p: Promise<unknown>) => p,
}));
vi.mock('@civitai/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof CivitaiAuth>();
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
    h.redisSet.mockResolvedValue('OK'); // SET NX succeeded — this request owns the upgrade window
    process.env.AUTH_JWT_ISSUER = 'https://auth.civitai.com'; // HUB_ORIGIN truthy + secure cookie naming
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const clears = (cookies: string[], name: string) =>
    cookies.some((c) => c.startsWith(`${name}=;`) && /Max-Age=0/i.test(c));

  it('on success sets the civ-token + civ-device AND clears the legacy session + ancillary next-auth cookies', async () => {
    h.exchangeLegacy.mockResolvedValue({ token: 'fresh.civ.jwt', deviceId: 'dev-minted' });
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com');
    const cookies = res.cookies();

    // The existing device cookie (here: none) is forwarded so the hub can reuse-or-mint.
    expect(h.exchangeLegacy).toHaveBeenCalledWith('legacy.jwe', { deviceCookie: undefined });
    // (a) the freshly-minted civ-token lands (and the merge didn't drop it when appending the ancillary clears)
    expect(cookies.some((c) => c.includes('fresh.civ.jwt'))).toBe(true);
    // (b) the hub's reused-or-minted device id lands as civ-device (so the upgraded session joins the switcher)
    expect(cookies.some((c) => c.startsWith('__Secure-civ-device=dev-minted'))).toBe(true);
    // (c) the legacy SESSION cookie is cleared (via clearLegacyCookies)
    expect(clears(cookies, '__Secure-civitai-token')).toBe(true);
    // (d) the ancillary next-auth cruft is cleared too
    expect(clears(cookies, '__Host-next-auth.csrf-token')).toBe(true);
    expect(clears(cookies, '__Secure-next-auth.callback-url')).toBe(true);
    expect(clears(cookies, '__Secure-next-auth.nonce')).toBe(true);
  });

  it('forwards an existing civ-device so the hub reuses this browser device set', async () => {
    h.exchangeLegacy.mockResolvedValue({ token: 'fresh.civ.jwt', deviceId: 'dev-existing' });
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', 'dev-existing', res, 'civitai.com');
    expect(h.exchangeLegacy).toHaveBeenCalledWith('legacy.jwe', { deviceCookie: 'dev-existing' });
    expect(res.cookies().some((c) => c.startsWith('__Secure-civ-device=dev-existing'))).toBe(true);
  });

  it('does nothing when the hub declines the exchange (no civ-token, no clears)', async () => {
    h.exchangeLegacy.mockResolvedValue(null);
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com');
    expect(res.cookies()).toEqual([]);
  });

  it('no-ops without a legacy token (never calls the hub)', async () => {
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession(undefined, undefined, res, 'civitai.com');
    expect(h.exchangeLegacy).not.toHaveBeenCalled();
    expect(res.cookies()).toEqual([]);
  });

  it('no-ops when the hub origin is unconfigured (never calls the hub)', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    vi.resetModules();
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com');
    expect(h.exchangeLegacy).not.toHaveBeenCalled();
  });

  // The growth driver: upgrading mints a NEW jti, and the only thing that stopped it repeating was the client
  // persisting the cookie we set. A client that ignores Set-Cookie re-minted on every request forever.
  describe('per-cookie dedupe window', () => {
    it('skips the hub entirely when another request already claimed the window', async () => {
      h.redisSet.mockResolvedValue(null); // SET NX lost the race — someone already upgraded this cookie
      const { maybeUpgradeLegacySession } = await import('../session-client');
      const res = fakeRes();

      await maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com');

      expect(h.exchangeLegacy).not.toHaveBeenCalled();
      expect(res.cookies()).toEqual([]);
    });

    it('claims the window with SET NX + a TTL, keyed on a HASH of the cookie (never the cookie itself)', async () => {
      const { maybeUpgradeLegacySession } = await import('../session-client');
      h.exchangeLegacy.mockResolvedValue({ token: 'fresh.civ.jwt', deviceId: 'd' });

      await maybeUpgradeLegacySession('legacy.jwe', undefined, fakeRes(), 'civitai.com');

      const [key, value, opts] = h.redisSet.mock.calls[0];
      expect(key).toMatch(/^session:legacy-upgrade-lock:/);
      expect(key).not.toContain('legacy.jwe');
      expect(value).toBe('1'); // no credential stored under the marker
      expect(opts).toMatchObject({ NX: true });
      expect(opts.EX).toBeGreaterThan(0);
    });

    it('fails OPEN when sysRedis is unreachable — a blip must not block migration', async () => {
      h.redisSet.mockRejectedValue(new Error('sysredis down'));
      h.exchangeLegacy.mockResolvedValue({ token: 'fresh.civ.jwt', deviceId: 'd' });
      const { maybeUpgradeLegacySession } = await import('../session-client');
      const res = fakeRes();

      await maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com');

      expect(h.exchangeLegacy).toHaveBeenCalled();
      expect(res.cookies().some((c) => c.includes('fresh.civ.jwt'))).toBe(true);
    });
  });

  it('is fire-safe: a rejecting exchange never throws and sets nothing', async () => {
    h.exchangeLegacy.mockRejectedValue(new Error('hub down'));
    const { maybeUpgradeLegacySession } = await import('../session-client');
    const res = fakeRes();

    await expect(
      maybeUpgradeLegacySession('legacy.jwe', undefined, res, 'civitai.com')
    ).resolves.toBeUndefined();
    expect(res.cookies().some((c) => c.includes('fresh'))).toBe(false);
  });
});
