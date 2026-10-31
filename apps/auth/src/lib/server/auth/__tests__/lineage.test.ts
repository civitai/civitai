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
vi.mock('../../redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
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
import { addDeviceFamily, endDeviceSessions, markFamilyLive } from '../lineage';
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
  h.sys ??= makeSysRedis();
  h.sys.reset();
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

describe("a browser's family record", () => {
  it('a sign-in with no prior session on a browser with a record moves to a new device id', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['someone-else']);
    const jar = makeCookies({ 'civ-device': 'device-1' });

    await establishSession(jar, user(200));

    const fresh = jar.get('civ-device')!;
    const { jti } = h.minted[0];
    expect(fresh).not.toBe('device-1');
    expect([...h.sys.sets.get(deviceFamilies('device-1'))!]).toEqual(['someone-else']);
    expect([...h.sys.sets.get(deviceFamilies(fresh))!]).toEqual([jti]);

    // Signing out presenting the old id ends only the caller's own family.
    await endDeviceSessions({ jti: jti! }, 'device-1');
    expect(await revoked({ jti: jti! })).toBe(true);
    expect(await revoked({ jti: 'x', sid: 'someone-else' })).toBe(false);
  });

  it("a sign-in while the browser's recorded session is signed in joins its record", async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['family-a', 'earlier']);
    h.verified.set('prior-token', { sub: '100', jti: 'j', sid: 'family-a' });
    const jar = makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' });

    await establishSession(jar, user(100));

    expect(jar.get('civ-device')).toBe('device-1');
    expect([...h.sys.sets.get(deviceFamilies('device-1'))!].sort()).toEqual([
      'earlier',
      'family-a',
    ]);
  });

  it("a site session for another account joins the record on the hub session's proof", async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['family-a']);

    expect(await addDeviceFamily('device-1', 'family-b', { proofFamily: 'family-a' })).toBe(
      'added'
    );
    expect(await addDeviceFamily('device-1', 'family-c')).toBe('rotate');

    await endDeviceSessions({ jti: 'j', sid: 'family-a' }, 'device-1');
    expect(await revoked({ jti: 'x', sid: 'family-b' })).toBe(true);
    expect(await revoked({ jti: 'y', sid: 'family-c' })).toBe(false);
  });

  it("a site session on a browser with no record also records the hub session's family", async () => {
    expect(await addDeviceFamily('device-1', 'family-b', { proofFamily: 'hub-fam' })).toBe('added');
    expect([...h.sys.sets.get(deviceFamilies('device-1'))!].sort()).toEqual([
      'family-b',
      'hub-fam',
    ]);

    await endDeviceSessions({ jti: 'j', sid: 'hub-fam' }, 'device-1');
    expect(await revoked({ jti: 'x', sid: 'family-b' })).toBe(true);
  });

  it('signing out still clears the record when ending one of its families fails', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['mine', 'b', 'c']);
    await h.sys.hSet(deviceAccounts('device-1'), '100', '1');
    const real = sessions.invalidateFamily;
    const spy = vi
      .spyOn(sessions, 'invalidateFamily')
      .mockImplementation(async (f: string) =>
        f === 'b' ? Promise.reject(new Error('blip')) : real(f)
      );

    await endDeviceSessions({ jti: 'j', sid: 'mine' }, 'device-1');
    spy.mockRestore();

    expect(await revoked({ jti: 'x', sid: 'c' })).toBe(true);
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
  });

  it('a used family is remembered for 30 days', async () => {
    await markFamilyLive('family-a');
    expect(h.sys.ttls.get(`${REDIS_SYS_KEYS.SESSION.FAMILY_LIVE}|family-a`)).toBe(
      30 * 24 * 60 * 60
    );
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
