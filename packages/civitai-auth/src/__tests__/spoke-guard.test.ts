import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the session client (no redis/jose) so we drive getSessionUser directly, and the env (hub base URL).
const h = vi.hoisted(() => ({ getSessionUser: vi.fn(), loadAuthEnv: vi.fn() }));
vi.mock('../session-client', () => ({
  createSessionClient: () => ({
    getSessionUser: h.getSessionUser,
    invalidate: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock('../env', () => ({ loadAuthEnv: h.loadAuthEnv }));

import { createSpokeGuard, type SpokeGuardConfig } from '../spoke-guard';
import type { SessionUser } from '../types';

const ISSUER = 'http://localhost:5173'; // http → non-secure cookie name 'civ-token'
const RETURN = 'http://localhost:3100/cases/42';
const LOGIN = `${ISSUER}/login?returnUrl=${encodeURIComponent(RETURN)}`;
const ORIGINAL_ENV = { ...process.env };

const mod = { id: 1, isModerator: true } as unknown as SessionUser;
const normie = { id: 2, isModerator: false } as unknown as SessionUser;
const isRevoked = () => false;
const guardOf = (config: Partial<SpokeGuardConfig> = {}) =>
  createSpokeGuard({ isRevoked, ...config });

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.AUTH_SESSION_COOKIE_MODE;
  process.env.AUTH_JWT_ISSUER = ISSUER; // drives isSecureCookie → cookie name 'civ-token'
  h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: ISSUER });
  h.getSessionUser.mockReset();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createSpokeGuard', () => {
  it('refuses to build without isRevoked', () => {
    expect(() => createSpokeGuard({} as SpokeGuardConfig)).toThrow(/isRevoked/);
  });

  it('→ login redirect (carrying returnUrl) when there is no session cookie; never calls the hub', async () => {
    const r = await guardOf().check('', RETURN);
    expect(r).toEqual({ status: 'login', redirect: LOGIN });
    expect(h.getSessionUser).not.toHaveBeenCalled();
  });

  it('→ login when the token does not resolve to a user', async () => {
    h.getSessionUser.mockResolvedValue(null);
    const r = await guardOf().check('civ-token=bad', RETURN);
    expect(r.status).toBe('login');
    expect(h.getSessionUser).toHaveBeenCalledWith('bad');
  });

  it('→ ok with the user when authenticated and no `require`', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    expect(await guardOf().check('civ-token=t', RETURN)).toEqual({
      status: 'ok',
      user: normie,
      setCookies: [],
    });
  });

  it('→ forbidden (NOT a login loop) for a logged-in user who fails `require`', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    const guard = guardOf({ require: (u) => !!u.isModerator });
    expect(await guard.check('civ-token=t', RETURN)).toEqual({ status: 'forbidden', user: normie });
  });

  it('→ ok when `require` passes', async () => {
    h.getSessionUser.mockResolvedValue(mod);
    const guard = guardOf({ require: (u) => !!u.isModerator });
    expect(await guard.check('civ-token=t', RETURN)).toMatchObject({ status: 'ok', user: mod });
  });

  it('extracts the right cookie from a multi-cookie header', async () => {
    h.getSessionUser.mockResolvedValue(normie);
    await guardOf().check('foo=1; civ-token=the-token; bar=2', RETURN);
    expect(h.getSessionUser).toHaveBeenCalledWith('the-token');
  });

  it('honors a custom loginPath', async () => {
    const r = (await guardOf({ loginPath: '/sign-in' }).check('', RETURN)) as {
      redirect: string;
    };
    expect(r.redirect).toBe(`${ISSUER}/sign-in?returnUrl=${encodeURIComponent(RETURN)}`);
  });
});

// ── Secure names: the two slots are distinct (`__Secure-civ-token` / `__Host-civ-token`) ──
const HUB = 'https://auth.civitai.com';
const PAGE = 'https://moderator.civitai.com/reports/7?tab=open';
const AUTHORIZE = `https://moderator.civitai.com/api/auth/authorize?returnUrl=${encodeURIComponent(
  '/reports/7?tab=open'
)}`;
const SHARED = '__Secure-civ-token';
const HOST = '__Host-civ-token';
const DAY = 24 * 60 * 60;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'ES256' })}.${b64(claims)}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);
const aged = (days: number) => jwt({ iat: nowS() - days * DAY, exp: nowS() + 30 * DAY });

describe('createSpokeGuard (cookie mode)', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_ISSUER = HUB;
    h.loadAuthEnv.mockReturnValue({ AUTH_JWT_ISSUER: HUB });
    h.getSessionUser.mockResolvedValue(normie);
  });

  it('shared mode: a signed-out request goes to the hub login, page load or not (as today)', async () => {
    h.getSessionUser.mockResolvedValue(null);
    const login = `${HUB}/login?returnUrl=${encodeURIComponent(PAGE)}`;
    expect(await guardOf().check('', PAGE)).toEqual({ status: 'login', redirect: login });
    expect(await guardOf().check('', PAGE, { navigation: false })).toEqual({
      status: 'login',
      redirect: login,
    });
  });

  it("host mode: a signed-out page load signs in on this app's own host", async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    expect(await guardOf().check('', PAGE)).toEqual({ status: 'login', redirect: AUTHORIZE });
  });

  it('host mode: a signed-out fetch gets reauth (401), not a redirect it cannot follow', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    expect(await guardOf().check('', PAGE, { navigation: false })).toEqual({
      status: 'reauth',
      authorize: AUTHORIZE,
    });
  });

  it('host mode: a revoked session on a fetch gets reauth', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    h.getSessionUser.mockResolvedValue(null);
    expect(await guardOf().check(`${HOST}=gone`, PAGE, { navigation: false })).toMatchObject({
      status: 'reauth',
    });
  });

  it('reads the host-only cookie when it is the only one (shared mode falls back to it)', async () => {
    await guardOf().check(`${HOST}=host-token`, PAGE);
    expect(h.getSessionUser).toHaveBeenCalledWith('host-token');
  });

  it('host mode: a page load carrying only the shared cookie signs in on this host', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    expect(await guardOf().check(`${SHARED}=${aged(0)}`, PAGE)).toEqual({
      status: 'login',
      redirect: AUTHORIZE,
    });
  });

  it('host mode: a fetch carrying only an old shared cookie is served and never copied to the host slot', async () => {
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    const refresh = vi.fn(async () => ({ token: aged(0) }));
    const r = await guardOf({ sessionTokenClient: { refresh } }).check(
      `${SHARED}=${aged(5)}`,
      PAGE,
      { navigation: false }
    );
    expect(r).toEqual({ status: 'ok', user: normie, setCookies: [] });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shared mode: an old shared cookie is not rolled here (the hub and the main app roll it)', async () => {
    const refresh = vi.fn(async () => ({ token: aged(0) }));
    const r = await guardOf({ sessionTokenClient: { refresh } }).check(
      `${SHARED}=${aged(5)}`,
      PAGE
    );
    expect(r).toMatchObject({ status: 'ok', setCookies: [] });
    expect(refresh).not.toHaveBeenCalled();
  });

  describe('roll', () => {
    beforeEach(() => {
      process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    });

    it('rolls an old host-only session in place, with the device id, and expires the shared pair', async () => {
      const fresh = aged(0);
      const refresh = vi.fn(async () => ({ token: fresh }));
      const r = await guardOf({ sessionTokenClient: { refresh } }).check(
        `${HOST}=${aged(2)}; __Host-civ-device=D1; ${SHARED}=old; __Secure-civ-device=D0`,
        PAGE,
        { navigation: false }
      );
      expect(refresh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deviceCookie: 'D1' })
      );
      expect(r.status).toBe('ok');
      const set = (r as { setCookies: string[] }).setCookies;
      expect(set[0]).toMatch(
        new RegExp(
          `^${HOST}=${fresh.replace(
            /\./g,
            '\\.'
          )}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=\\d+$`
        )
      );
      expect(set).toContain(
        '__Host-civ-device=D1; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000'
      );
      expect(set).toContain(`${SHARED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
      expect(set).toContain(
        '__Secure-civ-device=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
      );
      expect(set.some((c) => /Domain=/.test(c))).toBe(false);
    });

    it('does not expire a shared name the request does not carry', async () => {
      const refresh = vi.fn(async () => ({ token: aged(0) }));
      const r = await guardOf({ sessionTokenClient: { refresh } }).check(
        `${HOST}=${aged(2)}`,
        PAGE
      );
      expect((r as { setCookies: string[] }).setCookies).toHaveLength(1);
    });

    it('leaves a fresh session alone', async () => {
      const refresh = vi.fn(async () => ({ token: aged(0) }));
      const r = await guardOf({ sessionTokenClient: { refresh } }).check(
        `${HOST}=${aged(0)}`,
        PAGE
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(r).toMatchObject({ setCookies: [] });
    });

    it('keeps the current cookie when the hub declines', async () => {
      const onRollFailed = vi.fn();
      const refresh = vi.fn(async (_t: string, o?: { onFailure?: (r: 'declined') => void }) => {
        o?.onFailure?.('declined');
        return null;
      });
      const r = await guardOf({ sessionTokenClient: { refresh }, onRollFailed }).check(
        `${HOST}=${aged(2)}`,
        PAGE
      );
      expect(r).toMatchObject({ status: 'ok', setCookies: [] });
      expect(onRollFailed).toHaveBeenCalledWith('declined');
    });

    it('concurrent requests carrying the same old token share one hub refresh', async () => {
      const fresh = aged(0);
      const pending: Array<(v: { token: string }) => void> = [];
      const refresh = vi.fn(() => new Promise<{ token: string }>((r) => pending.push(r)));
      const guard = guardOf({ sessionTokenClient: { refresh } });
      const old = aged(2);
      const checks = Array.from({ length: 5 }, () => guard.check(`${HOST}=${old}`, PAGE));
      // Let every request reach the roll before the hub answers.
      await new Promise((r) => setTimeout(r, 0));
      for (const release of pending) release({ token: fresh });
      const results = await Promise.all(checks);
      expect(refresh).toHaveBeenCalledTimes(1);
      for (const r of results) {
        expect((r as { setCookies: string[] }).setCookies[0]).toMatch(`${HOST}=${fresh};`);
      }
    });

    it('a failed refresh is not reused: the next request asks the hub again', async () => {
      const refresh = vi
        .fn()
        .mockRejectedValueOnce(new Error('hub down'))
        .mockResolvedValueOnce({ token: aged(0) });
      const guard = guardOf({ sessionTokenClient: { refresh } });
      const old = aged(2);
      await expect(guard.check(`${HOST}=${old}`, PAGE)).rejects.toThrow('hub down');
      const r = await guard.check(`${HOST}=${old}`, PAGE);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect((r as { setCookies: string[] }).setCookies[0]).toMatch(/^__Host-civ-token=/);
    });

    it('shared mode still rolls a host-only session it falls back to (after a rollback)', async () => {
      delete process.env.AUTH_SESSION_COOKIE_MODE;
      const refresh = vi.fn(async () => ({ token: aged(0) }));
      const r = await guardOf({ sessionTokenClient: { refresh } }).check(
        `${HOST}=${aged(2)}`,
        PAGE
      );
      expect((r as { setCookies: string[] }).setCookies[0]).toMatch(/^__Host-civ-token=/);
    });
  });
});
