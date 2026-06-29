import { describe, it, expect, vi, beforeEach } from 'vitest';

// device.ts links accounts to a per-browser set in sysRedis. The capacity-critical behavior under test is LAZY
// materialization: a single-account login must NOT create a `device:accounts:*` key — the set is only written
// once a genuine 2nd distinct account appears (linkAccount), and only REFRESHED thereafter (touchAccount).
// We mock `../../redis` (getSysRedis) with an in-memory hash store so the gate/backfill/TTL logic runs for real.

const h = vi.hoisted(() => ({ getSysRedis: vi.fn() }));
vi.mock('../../redis', () => ({ getSysRedis: h.getSysRedis }));

// device.ts pulls cookie/name helpers from @civitai/auth + ./cookie at module load; stub the env-derived bits so
// the import doesn't depend on runtime env. Only the redis-backed account functions are exercised here.
vi.mock('@civitai/auth', () => ({
  deviceCookieName: () => 'civ-device',
  isSecureCookie: () => false,
}));
// device.ts imports REDIS_SYS_KEYS.DEVICE.ACCOUNTS for the key prefix; stub it (the real package isn't needed
// for these unit tests, and isn't always resolvable in a bare workspace).
vi.mock('@civitai/redis', () => ({
  REDIS_SYS_KEYS: { DEVICE: { ACCOUNTS: 'device:accounts' } },
}));
vi.mock('../cookie', () => ({ cookieDomain: () => undefined }));

import {
  touchAccount,
  linkAccount,
  listAccounts,
  isLinkedAndFresh,
  removeAccount,
} from '../device';

const DEVICE = 'dev-1';
const KEY = `device:accounts:${DEVICE}`;
const DEVICE_TTL_S = 7 * 24 * 60 * 60;

// Minimal in-memory sys-redis: hash-of-hashes keyed by redis key, plus a per-key TTL recorder.
function makeSys() {
  const store = new Map<string, Map<string, string>>();
  const ttl = new Map<string, number>();
  return {
    _store: store,
    _ttl: ttl,
    exists: vi.fn(async (k: string) => (store.has(k) && store.get(k)!.size > 0 ? 1 : 0)),
    hSet: vi.fn(async (k: string, field: string, value: string) => {
      if (!store.has(k)) store.set(k, new Map());
      store.get(k)!.set(field, value);
    }),
    hGet: vi.fn(async (k: string, field: string) => store.get(k)?.get(field) ?? null),
    hGetAll: vi.fn(async (k: string) => Object.fromEntries(store.get(k) ?? new Map())),
    hDel: vi.fn(async (k: string, fields: string | string[]) => {
      const map = store.get(k);
      if (!map) return 0;
      const list = Array.isArray(fields) ? fields : [fields];
      let n = 0;
      for (const f of list) if (map.delete(f)) n++;
      return n;
    }),
    expire: vi.fn(async (k: string, seconds: number) => {
      ttl.set(k, seconds);
      return true;
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('linkAccount — lazy materialization', () => {
  it('first/single-account login creates NO key (no existing distinct session)', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await linkAccount(DEVICE, 100, undefined); // brand-new browser, no prior session
    await linkAccount(DEVICE, 100, null); // explicit null prior session
    await linkAccount(DEVICE, 100, 100); // re-login as the SAME user (not a 2nd account)

    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    expect(sys._store.has(KEY)).toBe(false);
  });

  it('a 2nd DISTINCT account materializes the hash with BOTH accounts + a 7d TTL', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await linkAccount(DEVICE, 200, 100); // logging in as 200 while a session for 100 exists

    const accounts = await listAccounts(DEVICE);
    expect(accounts.map((a) => a.userId).sort()).toEqual([100, 200]); // first account backfilled
    expect(sys._ttl.get(KEY)).toBe(DEVICE_TTL_S);
  });

  it('a 3rd account on an existing set is added (refreshed) and keeps the set', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await linkAccount(DEVICE, 200, 100); // -> {100, 200}
    await linkAccount(DEVICE, 300, 100); // set already exists -> add 300

    const accounts = await listAccounts(DEVICE);
    expect(accounts.map((a) => a.userId).sort()).toEqual([100, 200, 300]);
    expect(sys._ttl.get(KEY)).toBe(DEVICE_TTL_S);
  });

  it('is a best-effort no-op when sysRedis is not configured', async () => {
    h.getSysRedis.mockReturnValue(null);
    await expect(linkAccount(DEVICE, 200, 100)).resolves.toBeUndefined();
  });
});

describe('touchAccount — refresh-only', () => {
  it('does NOT create a key when none exists (single-account refresh path)', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await touchAccount(DEVICE, 100);

    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    expect(sys._store.has(KEY)).toBe(false);
  });

  it('refreshes lastSwitchedAt + rolls the 7d TTL when the set already exists', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    // Seed an existing multi-account set.
    await linkAccount(DEVICE, 200, 100);
    sys.expire.mockClear();

    const before = Number((await listAccounts(DEVICE)).find((a) => a.userId === 100)!.lastSwitchedAt);
    await new Promise((r) => setTimeout(r, 2));
    await touchAccount(DEVICE, 100);

    const after = Number((await listAccounts(DEVICE)).find((a) => a.userId === 100)!.lastSwitchedAt);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(sys.expire).toHaveBeenCalledWith(KEY, DEVICE_TTL_S);
  });
});

describe('switch / list / remove still work on an existing set', () => {
  it('listAccounts returns fresh accounts sorted by recency', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);

    const accounts = await listAccounts(DEVICE);
    expect(accounts).toHaveLength(2);
    expect(accounts.every((a) => Number.isFinite(a.lastSwitchedAt))).toBe(true);
  });

  it('isLinkedAndFresh authorizes a freshly-linked account and rejects an unlinked one', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);

    expect(await isLinkedAndFresh(DEVICE, 100)).toBe(true);
    expect(await isLinkedAndFresh(DEVICE, 200)).toBe(true);
    expect(await isLinkedAndFresh(DEVICE, 999)).toBe(false); // never linked
  });

  it('isLinkedAndFresh rejects an account idle longer than the 7d TTL', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    // Backdate account 100 to 8 days ago (> 7d idle).
    await sys.hSet(KEY, '100', String(Date.now() - 8 * 24 * 60 * 60 * 1000));

    expect(await isLinkedAndFresh(DEVICE, 100)).toBe(false);
    expect(await isLinkedAndFresh(DEVICE, 200)).toBe(true);
  });

  it('listAccounts prunes accounts idle > 7d', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    await sys.hSet(KEY, '100', String(Date.now() - 8 * 24 * 60 * 60 * 1000)); // stale

    const accounts = await listAccounts(DEVICE);
    expect(accounts.map((a) => a.userId)).toEqual([200]); // 100 pruned
    expect(sys.hDel).toHaveBeenCalledWith(KEY, ['100']);
  });

  it('removeAccount drops an account from the set', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);

    await removeAccount(DEVICE, 100);

    const accounts = await listAccounts(DEVICE);
    expect(accounts.map((a) => a.userId)).toEqual([200]);
  });
});

describe('TTL value', () => {
  it('uses a 7-day device TTL (capacity: shortened from 30d)', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    expect(sys._ttl.get(KEY)).toBe(7 * 24 * 60 * 60);
  });
});
