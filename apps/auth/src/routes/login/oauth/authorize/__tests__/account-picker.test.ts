import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { luaSysRedis } from '../../../../../test/lua-sys-redis';

// The consent screen's account picker and its switch follow the same membership rule as /api/auth/switch: the
// signed-in account (or the moderator impersonating it) must be in this browser's account list. Device records
// run in real Lua.

const h = vi.hoisted(() => ({
  sys: undefined as unknown as ReturnType<typeof luaSysRedis>,
  setSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () =>
        Promise.resolve({
          id: 'game-frame',
          name: 'Games',
          description: null,
          logoUrl: null,
          isVerified: true,
          redirectUris: ['https://games.example.com/cb'],
        });
      return qb;
    },
  },
}));
vi.mock('$lib/server/redis', () => ({
  getSysRedis: () => h.sys,
  getRedis: () => null,
  evalSys: (script: string, keys: string[], args: string[]) =>
    h.sys.eval(script, { keys, arguments: args }),
}));
vi.mock('$lib/server/auth/session', () => ({
  mintUserSession: async () => 'minted',
  setSessionCookie: h.setSessionCookie,
}));
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: `u${id}` }),
}));

import { REDIS_SYS_KEYS } from '@civitai/redis';
import { luaSysRedis as makeLuaSysRedis } from '../../../../../test/lua-sys-redis';
import { load, actions } from '../+page.server';

const DEVICE = 'device-1';
const cookies = {
  get: (name: string) => (name === 'civ-device' ? DEVICE : undefined),
  set: vi.fn(),
};

function loadAs(userId: number, impersonatedBy?: number, prompt?: string) {
  const url = new URL('https://auth.civitai.com/login/oauth/authorize');
  url.searchParams.set('client_id', 'game-frame');
  url.searchParams.set('redirect_uri', 'https://games.example.com/cb');
  url.searchParams.set('scope', 'UserRead');
  if (prompt) url.searchParams.set('prompt', prompt);
  return load({
    url,
    locals: { user: { id: userId }, impersonatedBy },
    cookies,
    setHeaders: vi.fn(),
  } as never) as Promise<Record<string, unknown>>;
}

async function switchAs(userId: number, target: number, impersonatedBy?: number) {
  const body = new FormData();
  body.set('userId', String(target));
  body.set('client_id', 'game-frame');
  try {
    const result = await actions.switch({
      request: new Request('https://auth.civitai.com/login/oauth/authorize?/switch', {
        method: 'POST',
        body,
      }),
      cookies,
      locals: { user: { id: userId }, impersonatedBy },
      url: new URL('https://auth.civitai.com/login/oauth/authorize'),
    } as never);
    return (result as { status?: number }).status;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

beforeEach(() => {
  h.sys = makeLuaSysRedis();
  h.setSessionCookie.mockClear();
  const now = String(Date.now());
  h.sys.lua.setHash(`${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${DEVICE}`, { '100': now, '200': now });
});

describe('consent screen account picker', () => {
  it('shows the list to an account in it', async () => {
    const page = await loadAs(100);
    expect((page.accounts as { userId: number }[]).map((a) => a.userId).sort()).toEqual([100, 200]);
  });

  it('shows the list to a moderator in it who is impersonating someone outside it', async () => {
    expect(((await loadAs(400, 100)).accounts as unknown[]).length).toBe(2);
  });

  it('select_account shows an account outside the list only itself', async () => {
    const page = await loadAs(300, undefined, 'select_account');
    expect((page.accounts as { userId: number }[]).map((a) => a.userId)).toEqual([300]);
  });

  it('shows no picker to an account outside the list', async () => {
    expect((await loadAs(300)).accounts).toEqual([]);
  });
});

describe('consent screen switch', () => {
  it('switches an account in the list to another in it', async () => {
    expect(await switchAs(100, 200)).toBe(303);
    expect(h.setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('switches a moderator in the list who is impersonating someone outside it', async () => {
    expect(await switchAs(400, 200, 100)).toBe(303);
  });

  it('refuses an account outside the list and sets no session', async () => {
    expect(await switchAs(300, 100)).toBe(403);
    expect(h.setSessionCookie).not.toHaveBeenCalled();
  });
});
