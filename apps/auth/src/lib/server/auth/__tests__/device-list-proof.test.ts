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
vi.mock('../../redis', () => ({ getSysRedis: () => h.sys, getRedis: () => null }));
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
import { touchAccount } from '../device';
import { POST as switchPost } from '../../../../routes/api/auth/switch/+server';

const DEVICE = 'device-1';
const list = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}`;
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
  return { cookies, device: () => store.get('civ-device') };
}

async function switchStatus(userId: number, deviceId: string, target: number) {
  try {
    const res = await switchPost({
      request: new Request('https://auth.civitai.com/api/auth/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target }),
      }),
      cookies: { set: () => undefined },
      locals: { user: { id: userId }, deviceId },
    } as never);
    return res.status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

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

  it('a sign-in while an account in the list is signed in joins it and keeps the device id', async () => {
    h.verified.set('prior', { sub: '100', jti: 'j' });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200', '300']);
  });

  it('a sign-in while some other account is signed in starts a new list on a new device id', async () => {
    h.verified.set('prior', { sub: '400', jti: 'j' });
    const jar = makeCookies({ 'civ-device': DEVICE, 'civ-token': 'prior' });

    await establishSession(jar.cookies, user(300));

    expect(jar.device()).not.toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200']);
    expect(Object.keys(h.sys.lua.hash(list(jar.device()!))!).sort()).toEqual(['300', '400']);
  });

  it('an account already in the list signing in again keeps the device id and the list', async () => {
    const jar = makeCookies({ 'civ-device': DEVICE });

    await establishSession(jar.cookies, user(200));

    expect(jar.device()).toBe(DEVICE);
    expect(Object.keys(h.sys.lua.hash(list(DEVICE))!).sort()).toEqual(['100', '200']);
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
