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
  // Undefined (host-only, as on localhost) unless a test signs in toward a spoke on another domain.
  cookieDomain: undefined as string | undefined,
}));

// No user rows: the account checks at each mint pass, as for an ordinary account.
vi.mock('$lib/server/db/db', async () => ({
  db: (await import('../../../../test/kysely-fake')).createKyselyFake({}),
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
  cookieDomain: () => h.cookieDomain,
  clearOtherCookieNames: () => undefined,
}));
// A hand-off stores a pending authorization and checks the spoke registry (a database table).
vi.mock('../pending-authz', () => ({ issuePendingAuthz: async () => true }));
vi.mock('../../oauth/first-party', () => ({ isFirstPartyOrigin: async () => true }));

import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';
import type { Cookies } from '@sveltejs/kit';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { establishSession, sessionExpiresIn } from '../session';
import { addDeviceFamily, endDeviceSessions, markFamilyLive } from '../lineage';
import { canSwitch, linkAccount } from '../device';
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
const recorded = (deviceId: string) => {
  const members = h.sys.sets.get(deviceFamilies(deviceId));
  return members && [...members].sort();
};
const revoked = (claims: { jti: string; sid?: string }) =>
  sessions.isRevoked({ ...claims, signedAt: Date.now() });

beforeEach(() => {
  h.sys ??= makeSysRedis();
  h.sys.reset();
  h.minted = [];
  h.verified.clear();
  h.cookieDomain = undefined;
});

/** A sign-in on the hub bound for a spoke on another registrable domain: a hand-off, which mints nothing. */
async function handOff(jar: Cookies, userId: number) {
  h.cookieDomain = '.civitai.com';
  await establishSession(jar, user(userId), {
    returnUrl: 'https://civitai.red/api/auth/authorize?returnUrl=%2F',
  });
  expect(h.minted).toHaveLength(0);
}

describe('session families', () => {
  it('an account added on a signed-in browser joins its family, and one sign-out there ends both', async () => {
    h.verified.set('prior-token', {
      signedAt: Date.now(),
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

  // Regression (lazy family records): origin/main wrote a one-family record on every interactive sign-in.
  it('a first sign-in on a browser starts its own family, and a single-account browser gets no record', async () => {
    await establishSession(makeCookies({ 'civ-device': 'device-1' }), user(200));

    const { payload, jti } = h.minted[0];
    expect(payload.sid).toBeUndefined();
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);

    // Signing in again as the same account joins the same family: still one family, still no record.
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '200', jti: jti! });
    await establishSession(
      makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' }),
      user(200)
    );
    expect(h.minted[1].payload.sid).toBe(jti);
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
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
    // One family on the new device id: nothing more for a sign-out there to end, so no record.
    expect(h.sys.sets.has(deviceFamilies(fresh))).toBe(false);

    // Signing out presenting the old id ends only the caller's own family.
    await endDeviceSessions({ jti: jti! }, 'device-1');
    expect(await revoked({ jti: jti! })).toBe(true);
    expect(await revoked({ jti: 'x', sid: 'someone-else' })).toBe(false);
  });

  it("a sign-in while the browser's recorded session is signed in joins its record", async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['family-a', 'earlier']);
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '100', jti: 'j', sid: 'family-a' });
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

  it('a hub session the hub no longer honours does not count as signed in at a new sign-in', async () => {
    const now = String(Date.now());
    await h.sys.hSet(deviceAccounts('device-1'), '100', now);
    h.verified.set('prior-token', {
      sub: '100',
      jti: 'j',
      sid: 'fam-old',
      signedAt: Date.now() - 40 * DAY_MS,
    });
    const jar = makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' });

    await establishSession(jar, user(200));

    expect(h.minted[0].payload.sid).not.toBe('fam-old');
    expect(jar.get('civ-device')).not.toBe('device-1');
    expect(Object.fromEntries(h.sys.hashes.get(deviceAccounts('device-1'))!)).toEqual({
      '100': now,
    });
  });

  it('a site session on a browser with an account list but no record gets no record', async () => {
    await h.sys.hSet(deviceAccounts('device-1'), '100', '1');

    expect(await addDeviceFamily('device-1', 'family-b', { proofFamily: 'hub-fam' })).toBe(
      'rotate'
    );
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
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

  // Invariant guard: a spoke session in a new family is recorded with the hub session's family, so either
  // one's sign-out ends the other.
  it('signing out on a browser with two families ends both, from either one', async () => {
    for (const [device, signsOut] of [
      ['device-1', 'hub'],
      ['device-2', 'spoke'],
    ] as const) {
      await establishSession(makeCookies({ 'civ-device': device }), user(100));
      const hub = h.minted[h.minted.length - 1].jti!;

      expect(await addDeviceFamily(device, `spoke-${device}`, { proofFamily: hub })).toBe('added');
      expect(recorded(device)).toEqual([hub, `spoke-${device}`].sort());
      expect(h.sys.ttls.get(deviceFamilies(device))).toBe(91 * 24 * 60 * 60);

      const [caller, other] =
        signsOut === 'hub' ? [hub, `spoke-${device}`] : [`spoke-${device}`, hub];
      await endDeviceSessions({ jti: 'j', sid: caller }, device);
      expect(await revoked({ jti: 'x', sid: other })).toBe(true);
      expect(h.sys.sets.has(deviceFamilies(device))).toBe(false);
    }
  });

  // Invariant guard: an added account joins the prior session's family, so the browser has two accounts and
  // one family. Its record must still exist, or a sign-out leaves the account list behind.
  it('signing out on a browser with two accounts in one family forgets the account list', async () => {
    await establishSession(makeCookies({ 'civ-device': 'device-1' }), user(100));
    const fam = h.minted[0].jti!;
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '100', jti: fam });

    await establishSession(
      makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' }),
      user(200)
    );

    expect(h.minted[1].payload.sid).toBe(fam);
    expect([...(h.sys.hashes.get(deviceAccounts('device-1'))?.keys() ?? [])].sort()).toEqual([
      '100',
      '200',
    ]);
    expect(recorded('device-1')).toEqual([fam]);

    await endDeviceSessions({ jti: h.minted[1].jti!, sid: fam }, 'device-1');
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
  });

  // Regression: a hand-off (an account switch bound for a spoke on another domain) mints no family. origin/main
  // then wrote no record, relying on the one the prior sign-in had left; with lazy records there is none, so
  // the list stood without one, the spoke family was refused, and a sign-out left the list behind.
  it('a hand-off that starts an account list records the prior family, and a sign-out then forgets the list', async () => {
    expect(await linkAccount('device-1', 200, 100, { proofFamily: 'fam-a' })).toBe('created');
    expect(recorded('device-1')).toEqual(['fam-a']);
    expect(h.sys.ttls.get(deviceFamilies('device-1'))).toBe(91 * 24 * 60 * 60);

    // The spoke session the hand-off leads to, on the hub session's proof.
    expect(await addDeviceFamily('device-1', 'spoke-b', { proofFamily: 'fam-a' })).toBe('added');

    await endDeviceSessions({ jti: 'j', sid: 'fam-a' }, 'device-1');
    expect(await revoked({ jti: 'x', sid: 'spoke-b' })).toBe(true);
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
  });

  // Regression: origin/main's JOIN_SCRIPT recorded only the new family when it created a record, dropping the
  // prior family it had just been shown, unlike ADD_FAMILY_SCRIPT.
  it('a sign-in that creates a record records both its family and the prior one', async () => {
    expect(await linkAccount('device-1', 200, 100, { family: 'fam-b', proofFamily: 'fam-a' })).toBe(
      'created'
    );
    expect(recorded('device-1')).toEqual(['fam-a', 'fam-b']);

    // No account list, but two different families: a record of both.
    expect(await linkAccount('device-2', 100, 100, { family: 'fam-d', proofFamily: 'fam-c' })).toBe(
      'none'
    );
    expect(recorded('device-2')).toEqual(['fam-c', 'fam-d']);
  });

  // Invariant guard: a sign-in's refusal against an existing record is unchanged. Regression (second part): at
  // 438b898611 a hand-off was not checked against an existing record at all.
  it('an existing record refuses a sign-in or a hand-off it holds no proof for', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['theirs']);

    expect(await linkAccount('device-1', 200, 100, { family: 'fam-a', proofFamily: 'fam-a' })).toBe(
      'rotate'
    );
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
    expect(recorded('device-1')).toEqual(['theirs']);

    // A hand-off brings no new family, so it needs the prior family in the record, as a sign-in does.
    expect(await linkAccount('device-1', 200, 100, { proofFamily: 'fam-a' })).toBe('rotate');
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
    expect(recorded('device-1')).toEqual(['theirs']);

    expect(await addDeviceFamily('device-1', 'spoke-b', { proofFamily: 'fam-a' })).toBe('rotate');
    expect(await addDeviceFamily('device-1', 'spoke-c')).toBe('rotate');
    expect(recorded('device-1')).toEqual(['theirs']);
  });

  // Invariant guard (positive control for the refusal above): a hand-off whose prior family is in the record
  // starts the list on the same device id.
  it('a hand-off whose prior family is in the record keeps the device id and starts the list', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['fam-a', 'spoke-x']);

    expect(await linkAccount('device-1', 200, 100, { proofFamily: 'fam-a' })).toBe('created');
    expect([...(h.sys.hashes.get(deviceAccounts('device-1'))?.keys() ?? [])].sort()).toEqual([
      '100',
      '200',
    ]);
    expect(recorded('device-1')).toEqual(['fam-a', 'spoke-x']);
  });

  // Regression: at 438b898611 a hand-off on a device id whose record lacked the hub session's family started
  // the list there anyway; the spoke session was then refused by the record, the hub sign-out did not match
  // it, and the list (and a switch into the signed-out account) outlived the sign-out.
  it('a hand-off on a device id whose record lacks the hub family moves to a new id, and a sign-out ends it all', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['fam-x', 'fam-y']);
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '100', jti: 'fam-a' });
    const jar = makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' });

    await handOff(jar, 200);

    const moved = jar.get('civ-device')!;
    expect(moved).not.toBe('device-1');
    expect(h.sys.hashes.has(deviceAccounts('device-1'))).toBe(false);
    expect(recorded('device-1')).toEqual(['fam-x', 'fam-y']);
    expect([...(h.sys.hashes.get(deviceAccounts(moved))?.keys() ?? [])].sort()).toEqual([
      '100',
      '200',
    ]);
    expect(recorded(moved)).toEqual(['fam-a']);

    // The spoke session the hand-off leads to joins the record on the hub session's proof.
    expect(await addDeviceFamily(moved, 'spoke-b', { proofFamily: 'fam-a' })).toBe('added');
    expect(await canSwitch(moved, 200, 100)).toBe(true);

    await endDeviceSessions({ jti: 'j', sid: 'fam-a' }, moved);
    expect(await revoked({ jti: 'x', sid: 'spoke-b' })).toBe(true);
    expect(h.sys.hashes.has(deviceAccounts(moved))).toBe(false);
    expect(await canSwitch(moved, 200, 100)).toBe(false);
    expect(await canSwitch('device-1', 200, 100)).toBe(false);
  });

  // Regression vs origin/main (green at 438b898611): a hand-off refused by the browser's account list retries on
  // a new device id with the hub session's family, so the new list has a record the spoke session can join.
  it('a hand-off refused by the account list records the hub family on the new device id', async () => {
    const now = String(Date.now());
    await h.sys.hSet(deviceAccounts('device-1'), '300', now);
    await h.sys.hSet(deviceAccounts('device-1'), '301', now);
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '100', jti: 'fam-a' });
    const jar = makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' });

    await handOff(jar, 200);

    const moved = jar.get('civ-device')!;
    expect(moved).not.toBe('device-1');
    expect(Object.keys(Object.fromEntries(h.sys.hashes.get(deviceAccounts('device-1'))!))).toEqual([
      '300',
      '301',
    ]);
    expect(recorded(moved)).toEqual(['fam-a']);
    expect(await addDeviceFamily(moved, 'spoke-b', { proofFamily: 'fam-a' })).toBe('added');
    expect(recorded(moved)).toEqual(['fam-a', 'spoke-b']);
  });

  // Regression: both recorded one family with no record yet. The spoke exchange passes no proof when the hub
  // had no confirmed session; a family that is its own proof is still one family.
  it('a spoke session with no hub session, or a family that is its own proof, on a browser with no record writes none', async () => {
    expect(await addDeviceFamily('device-1', 'spoke-b')).toBe('added');
    expect(await addDeviceFamily('device-1', 'fam-a', { proofFamily: 'fam-a' })).toBe('added');
    expect(h.sys.sets.has(deviceFamilies('device-1'))).toBe(false);
  });

  // Regression: origin/main and 438b898611 slid the TTL of a single-family record on every join, so records
  // written before records became lazy never drained while their browser stayed active.
  it('a join leaves the TTL of a single-family record with no account list to run out', async () => {
    await h.sys.sAdd(deviceFamilies('device-1'), ['fam-a']);
    await h.sys.sAdd(deviceFamilies('device-2'), ['fam-b']);
    h.verified.set('prior-token', { signedAt: Date.now(), sub: '100', jti: 'fam-a' });

    // A spoke join in the same family, and a re-sign-in of the same account on the hub.
    expect(await addDeviceFamily('device-1', 'fam-a', { proofFamily: 'fam-a' })).toBe('added');
    await establishSession(
      makeCookies({ 'civ-token': 'prior-token', 'civ-device': 'device-1' }),
      user(100)
    );
    expect(await linkAccount('device-2', 100, 100, { family: 'fam-b', proofFamily: 'fam-b' })).toBe(
      'none'
    );

    expect(h.minted[0].payload.sid).toBe('fam-a');
    expect(recorded('device-1')).toEqual(['fam-a']);
    expect(recorded('device-2')).toEqual(['fam-b']);
    expect(h.sys.ttls.has(deviceFamilies('device-1'))).toBe(false);
    expect(h.sys.ttls.has(deviceFamilies('device-2'))).toBe(false);
  });

  // Invariant guard: a record that holds two families, or belongs to a browser with an account list, still has
  // its TTL slid by a join, so it outlives every family and list it covers.
  it('a join slides the TTL of a record with two families or an account list', async () => {
    const ttl = 91 * 24 * 60 * 60;
    // Becomes two families with this join (a spoke session).
    await h.sys.sAdd(deviceFamilies('device-1'), ['fam-a']);
    expect(await addDeviceFamily('device-1', 'spoke-b', { proofFamily: 'fam-a' })).toBe('added');
    expect(h.sys.ttls.get(deviceFamilies('device-1'))).toBe(ttl);

    // Already two families (a re-sign-in in one of them).
    await h.sys.sAdd(deviceFamilies('device-2'), ['fam-c', 'spoke-d']);
    expect(await linkAccount('device-2', 100, 100, { family: 'fam-c', proofFamily: 'fam-c' })).toBe(
      'none'
    );
    expect(h.sys.ttls.get(deviceFamilies('device-2'))).toBe(ttl);

    // One family, but the browser has an account list (a sign-in of an account in it, and a spoke join).
    const now = String(Date.now());
    await h.sys.sAdd(deviceFamilies('device-3'), ['fam-e']);
    await h.sys.hSet(deviceAccounts('device-3'), '100', now);
    await h.sys.hSet(deviceAccounts('device-3'), '200', now);
    expect(await linkAccount('device-3', 100, undefined, { family: 'fam-e' })).toBe('joined');
    expect(h.sys.ttls.get(deviceFamilies('device-3'))).toBe(ttl);
    h.sys.ttls.delete(deviceFamilies('device-3'));
    expect(await addDeviceFamily('device-3', 'fam-e', { proofFamily: 'fam-e' })).toBe('added');
    expect(h.sys.ttls.get(deviceFamilies('device-3'))).toBe(ttl);
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
