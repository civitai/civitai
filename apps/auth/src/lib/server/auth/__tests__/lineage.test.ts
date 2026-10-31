import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSysRedis, type SysRedisFake } from '../../../../test/sys-redis.fake';

// Sessions minted on one browser form a family; signing out ends the families that browser signed in with.
// Runs the real session registry and lineage records over an in-memory sys redis; only the signer and the
// verifier of the incoming cookie are stubbed.

const DAY_MS = 24 * 60 * 60 * 1000;

const h = vi.hoisted(() => ({
  sys: undefined as unknown as SysRedisFake,
  minted: [] as { payload: Record<string, unknown>; jti?: string; expiresIn?: number }[],
  verified: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  maybeCreateSessionSigner: () => ({
    maxAge: 30 * 24 * 60 * 60,
    mintSessionToken: async (
      payload: Record<string, unknown>,
      opts: { jti?: string; expiresIn?: number }
    ) => {
      h.minted.push({ payload, ...opts });
      return `token-${opts.jti}`;
    },
  }),
}));
vi.mock('../../redis', () => ({ getSysRedis: () => h.sys, getRedis: () => null }));
vi.mock('../verifier', () => ({
  verifier: {
    verifyToken: async (token: string) => {
      const claims = h.verified.get(token);
      if (!claims) throw new Error('invalid');
      return claims;
    },
  },
}));
vi.mock('../cookie', () => ({
  cookieDomain: () => undefined,
  clearOtherCookieNames: () => undefined,
}));

import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';
import type { Cookies } from '@sveltejs/kit';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { establishSession, sessionExpiresIn } from '../session';
import { endDeviceSessions } from '../lineage';
import { sessions } from '../registry';

const user = (id: number) => ({ id, username: `u${id}` } as unknown as SessionUser);

function makeCookies(initial: Record<string, string>): Cookies {
  const store = new Map(Object.entries(initial));
  return {
    get: (name: string) => store.get(name),
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void store.set(name, value),
    delete: (name: string) => void store.delete(name),
    serialize: (name: string, value: string) => `${name}=${value}`,
  };
}

const deviceFamilies = (deviceId: string) =>
  `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${deviceId}`;
const deviceAccounts = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}`;
const revoked = (claims: { jti: string; sid?: string }) =>
  sessions.isRevoked({ ...claims, signedAt: Date.now() });

beforeEach(() => {
  h.sys = makeSysRedis();
  h.minted = [];
  h.verified.clear();
});

describe('session families', () => {
  it('an account added on a signed-in browser joins its family, and one sign-out there ends both', async () => {
    h.verified.set('prior-token', {
      sub: '100',
      jti: 'child-of-a',
      sid: 'family-a',
      iat0: Date.now() - 80 * DAY_MS,
      impersonatedBy: 7,
    });
    const before = Date.now();

    await establishSession(
      makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' }),
      user(200)
    );

    const { payload } = h.minted[0];
    expect(payload.sid).toBe('family-a');
    expect(payload.iat0).toBeGreaterThanOrEqual(before);
    expect(payload.impersonatedBy).toBeUndefined();
    expect([...h.sys.sets.get(deviceFamilies('device-1'))!]).toEqual(['family-a']);

    // A spoke on another host minted from the same browser before the sign-out.
    expect(await revoked({ jti: 'spoke-session', sid: 'family-a' })).toBe(false);
    await endDeviceSessions({ jti: h.minted[0].jti!, sid: 'family-a' }, 'device-1');
    expect(await revoked({ jti: 'spoke-session', sid: 'family-a' })).toBe(true);
    expect(await revoked({ jti: 'family-a' })).toBe(true);
  });

  it('a first sign-in on a browser starts its own family', async () => {
    await establishSession(makeCookies({ 'civ-device': 'device-1' }), user(200));

    const { payload, jti } = h.minted[0];
    expect(payload.sid).toBeUndefined();
    expect([...h.sys.sets.get(deviceFamilies('device-1'))!]).toEqual([jti]);
  });

  it('signing out ends every family signed in on the browser and forgets its account list', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['mine', 'earlier-sign-in']);
    await h.sys.hSet(deviceAccounts('device-1'), '100', '1');

    await endDeviceSessions({ jti: 'j', sid: 'mine' }, 'device-1');

    expect(await revoked({ jti: 'x', sid: 'earlier-sign-in' })).toBe(true);
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
  });

  it("signing out with a device id the session never signed in on ends only the caller's own family", async () => {
    await h.sys.sAdd(deviceFamilies('someone-elses-device'), ['their-family']);
    await h.sys.hSet(deviceAccounts('someone-elses-device'), '300', '1');

    await endDeviceSessions({ jti: 'j', sid: 'mine' }, 'someone-elses-device');

    expect(await revoked({ jti: 'x', sid: 'mine' })).toBe(true);
    expect(await revoked({ jti: 'y', sid: 'their-family' })).toBe(false);
    expect(h.sys.hashes.has(deviceAccounts('someone-elses-device'))).toBe(true);
  });
});

describe('sessionExpiresIn', () => {
  const now = Date.UTC(2026, 9, 31);

  it('ends a session at the 90-day limit of its sign-in', () => {
    expect(sessionExpiresIn({ iat0: now - 89 * DAY_MS }, now)).toBe(24 * 60 * 60);
    expect(sessionExpiresIn({ iat0: now }, now)).toBe(30 * 24 * 60 * 60);
  });

  it('ends an impersonation session at its own limit', () => {
    expect(sessionExpiresIn({ iat0: now, impExp: now + 60_000 }, now)).toBe(60);
  });
});
