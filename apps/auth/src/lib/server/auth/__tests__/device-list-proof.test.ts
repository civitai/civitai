import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { luaSysRedis } from '../../../../test/lua-sys-redis';

// A browser's account list is joined only by a sign-in that shows the browser is signed in to it: the new
// account is already in the list, or the browser's prior hub session belongs to an account in it. Any other
// sign-in moves the browser to a new device id. The device scripts run in real Lua (wasmoon).

const h = vi.hoisted(() => ({
  sys: undefined as unknown as ReturnType<typeof luaSysRedis>,
  verified: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  isSecureCookie: () => false,
  maybeCreateSessionSigner: () => ({ maxAge: 3600, mintSessionToken: async () => 'minted' }),
}));
vi.mock('../../redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('../registry', () => ({ sessions: { trackToken: async () => undefined } }));
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
vi.mock('../session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id }),
}));

import type * as CivitaiAuth from '@civitai/auth';
import type { SessionUser } from '@civitai/auth';
import type { Cookies } from '@sveltejs/kit';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { luaSysRedis as makeLuaSysRedis } from '../../../../test/lua-sys-redis';
import { establishSession } from '../session';
import { linkAccount, touchAccount } from '../device';
import { POST as switchPost } from '../../../../routes/api/auth/switch/+server';
import { DELETE as removePost } from '../../../../routes/api/auth/accounts/+server';

const DEVICE = 'device-1';
const list = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}`;
const families = (deviceId: string) => `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${deviceId}`;
const user = (id: number) => ({ id, username: `u${id}` } as unknown as SessionUser);

function makeCookies(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const cookies: Cookies = {
    get: (name: string) => store.get(name),
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void store.set(name, value),
    delete: (name: string) => void store.delete(name),
    serialize: (name: string, value: string) => `${name}=${value}`,
  };
  return { cookies, device: () => store.get('civ-device'), token: () => store.get('civ-token') };
}

async function switchStatus(
  userId: number,
  deviceId: string,
  target: number,
  impersonatedBy?: number
) {
  try {
    const res = await switchPost({
      request: new Request('https://auth.civitai.com/api/auth/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target }),
      }),
      cookies: { set: () => undefined },
      locals: { user: { id: userId }, deviceId, impersonatedBy },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

async function removeStatus(
  userId: number,
  deviceId: string,
  target: number,
  impersonatedBy?: number
) {
  try {
    const res = await removePost({
      url: new URL(`https://auth.civitai.com/api/auth/accounts?userId=${target}`),
      locals: { user: { id: userId }, deviceId, impersonatedBy },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 30 * DAY_MS;

let now: string;
beforeEach(() => {
  h.sys = makeLuaSysRedis();
  h.verified.clear();
  now = String(Date.now());
  h.sys.lua.setHash(list(DEVICE), { '100': now, '200': now });
});

describe('signing in on a browser with an account list', () => {
  it('a sign-in with no prior session moves to a new device id and leaves the list alone', async () => {
    const jar = makeCookies({ 'civ-device': DEVICE });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).not.toBe(DEVICE);
    expect(h.sys.lua.hash(list(DEVICE))).toEqual({ '100': now, '200': now });
    expect(h.sys.lua.hash(list(jar.device()!))).toBeUndefined();
    expect(h.sys.lua.errors).toEqual([]);
  });

  it("that sign-in can't switch into the list by presenting the old device id", async () => {
    await establishSession(makeCookies({ 'civ-device': DEVICE }).cookies, user(300));

    expect(await switchStatus(300, DEVICE, 100)).toBe(403);
  });

  it('a moderator in the list, impersonating someone outside it, can switch', async () => {
    expect(await switchStatus(400, DEVICE, 200, 100)).toBe(200);
  });

  it('an account in the list can switch to another in it (positive control)', async () => {
    expect(await switchStatus(100, DEVICE, 200)).toBe(200);
  });

  it('a sign-in while an account in the list is signed in joins it and keeps the device id', async () => {
    h.verified.set('prior', { signedAt: Date.now(), sub: '100', jti: 'j' });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200', '300']);
    expect(h.sys.lua.pttl(list(DEVICE))).toBe(TTL_MS);
  });

  it('a sign-in while a moderator in the list is impersonating someone joins it', async () => {
    h.verified.set('prior', { signedAt: Date.now(), sub: '400', jti: 'j', impersonatedBy: 100 });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200', '300']);
  });

  it('a sign-in still completes when the account list cannot be read', async () => {
    h.sys.eval = async () => {
      throw new Error('redis blip');
    };
    const jar = makeCookies({ 'civ-device': DEVICE });

    await expect(establishSession(jar.cookies, user(300))).resolves.toBeUndefined();
    expect(jar.token()).toBe('minted');
  });

  it('a sign-in while some other account is signed in starts a new list on a new device id', async () => {
    h.verified.set('prior', { signedAt: Date.now(), sub: '400', jti: 'j' });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).not.toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200']);
    expect(Object.keys(h.sys.lua.hash(list(jar.device()!))!).sort()).toEqual(['300', '400']);
    expect(h.sys.lua.pttl(list(jar.device()!))).toBe(TTL_MS);
  });

  it('an account already in the list signing in again keeps the device id and the list', async () => {
    const jar = makeCookies({ 'civ-device': DEVICE });

    await establishSession(jar.cookies, user(200));

    expect(jar.device()).toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200']);
  });
});

describe('account last used long ago', () => {
  it('a sign-in of an account idle past 30 days moves to a new device id and adds nothing', async () => {
    const idle = String(Date.now() - 31 * DAY_MS);
    h.sys.lua.setHash(list(DEVICE), { '100': now, '200': idle });
    const jar = makeCookies({ 'civ-device': DEVICE });

    await establishSession(jar.cookies, user(200));

    expect(jar.device()).not.toBe(DEVICE);
    expect(h.sys.lua.hash(list(DEVICE))).toEqual({ '100': now, '200': idle });
  });

  it('one used within 30 days keeps the device id', async () => {
    h.sys.lua.setHash(list(DEVICE), { '100': now, '200': String(Date.now() - DAY_MS) });
    const jar = makeCookies({ 'civ-device': DEVICE });

    await establishSession(jar.cookies, user(200));

    expect(jar.device()).toBe(DEVICE);
  });
});

describe('a prior session whose account was last used long ago', () => {
  it('does not let a new account join the list', async () => {
    const idle = String(Date.now() - TTL_MS - DAY_MS);
    h.sys.lua.setHash(list(DEVICE), { '100': idle, '200': now });
    h.verified.set('prior', { signedAt: Date.now(), sub: '100', jti: 'j' });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).not.toBe(DEVICE);
    expect(h.sys.lua.hash(list(DEVICE))).toEqual({ '100': idle, '200': now });
  });
});

describe('creating a list', () => {
  it('a second sign-in pair on the same new device id is refused rather than merged', async () => {
    const fresh = 'device-2';
    expect(await linkAccount(fresh, 200, 100)).toBe('created');
    expect(await linkAccount(fresh, 400, 300)).toBe('rotate');
    expect(Object.keys(h.sys.lua.hash(list(fresh))!).sort()).toEqual(['100', '200']);
    expect(h.sys.lua.pttl(list(fresh))).toBe(TTL_MS);
  });
});

describe("the browser's family record", () => {
  it('a sign-in that would start a new list is not proof for a family record it is not in', async () => {
    const victim = 'device-3';
    h.sys.lua.setSet(families(victim), ['victim-fam']);
    h.verified.set('prior', { signedAt: Date.now(), sub: '300', sid: 'atk-fam', jti: 'j' });
    const jar = makeCookies({ 'civ-device': victim, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(301));

    expect(jar.device()).not.toBe(victim);
    expect(h.sys.lua.set(families(victim))).toEqual(['victim-fam']);
    expect(h.sys.lua.hash(list(victim))).toBeUndefined();
    expect(h.sys.lua.errors).toEqual([]);
  });

  it('a first added account keeps the device id and starts the list', async () => {
    const device = 'device-5';
    h.sys.lua.setSet(families(device), ['fam-a']);
    h.verified.set('prior', { signedAt: Date.now(), sub: '100', sid: 'fam-a', jti: 'j' });
    const jar = makeCookies({ 'civ-device': device, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(200));

    expect(jar.device()).toBe(device);
    expect(Object.keys(h.sys.lua.hash(list(device))!).sort()).toEqual(['100', '200']);
    expect(h.sys.lua.set(families(device))).toEqual(['fam-a']);
  });

  it('a single-account browser signing in after its session lapsed moves to a new device id', async () => {
    const device = 'device-6';
    h.sys.lua.setSet(families(device), ['old-fam']);
    const jar = makeCookies({ 'civ-device': device });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).not.toBe(device);
    expect(h.sys.lua.set(families(device))).toEqual(['old-fam']);
    expect(h.sys.lua.set(families(jar.device()!))).toHaveLength(1);
  });

  it('an account in the list signing in again joins the family record', async () => {
    const device = 'device-4';
    h.sys.lua.setSet(families(device), ['old-fam']);
    h.sys.lua.setHash(list(device), { '300': now, '301': now });
    const jar = makeCookies({ 'civ-device': device });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).toBe(device);
    expect(h.sys.lua.set(families(device))).toHaveLength(2);
    expect(h.sys.lua.set(families(device))).toContain('old-fam');
  });
});

describe('removing an account from the list', () => {
  it('an account outside the list is refused and the list is unchanged', async () => {
    expect(await removeStatus(300, DEVICE, 100)).toBe(403);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200']);
  });

  it('a moderator in the list, impersonating someone outside it, removes an account', async () => {
    expect(await removeStatus(400, DEVICE, 200, 100)).toBe(200);
  });

  it('an account in the list removes another, or itself', async () => {
    expect(await removeStatus(100, DEVICE, 200)).toBe(200);
    expect(await removeStatus(100, DEVICE, 100)).toBe(200);
    expect(h.sys.lua.hash(list(DEVICE))).toBeUndefined();
  });
});

describe('touchAccount', () => {
  it('never adds an account to a list', async () => {
    await touchAccount(DEVICE, 300);
    expect(h.sys.lua.hash(list(DEVICE))).toEqual({ '100': now, '200': now });
    expect(h.sys.lua.errors).toEqual([]);
  });

  it("slides a listed account's last-used time", async () => {
    h.sys.lua.setHash(list(DEVICE), { '100': '1', '200': '1' });
    await touchAccount(DEVICE, 200);
    expect(Number(h.sys.lua.hash(list(DEVICE))!['200'])).toBeGreaterThan(1);
    expect(h.sys.lua.hash(list(DEVICE))!['100']).toBe('1');
  });
});
