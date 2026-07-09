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
const DEVICE_TTL_S = 30 * 24 * 60 * 60;

// Minimal in-memory sys-redis: hash-of-hashes keyed by redis key, plus a per-key TTL recorder.
function makeSys() {
  const store = new Map<string, Map<string, string>>();
  const ttl = new Map<string, number>();
  return {
    _store: store,
    _ttl: ttl,
    exists: vi.fn(async (k: string) => (store.has(k) && store.get(k)!.size > 0 ? 1 : 0)),
    // Field count of the stored hash (0 if absent) — mirrors redis HLEN, which touchAccount now gates on.
    hLen: vi.fn(async (k: string) => store.get(k)?.size ?? 0),
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
    // Atomic materialize primitive (mirrors @civitai/redis hSetMultiWithExpire): writes every
    // [field, value, …] pair AND the TTL in one operation, so the in-memory store models the
    // real client's "never a TTL-less key" guarantee.
    hSetMultiWithExpire: vi.fn(async (k: string, fields: string[], seconds: number) => {
      if (fields.length === 0) return 0;
      if (!store.has(k)) store.set(k, new Map());
      const map = store.get(k)!;
      let added = 0;
      for (let i = 0; i < fields.length; i += 2) {
        if (!map.has(fields[i])) added++;
        map.set(fields[i], fields[i + 1]);
      }
      ttl.set(k, seconds);
      return added;
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
    expect(sys.hSetMultiWithExpire).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    expect(sys._store.has(KEY)).toBe(false);
  });

  it('a 2nd DISTINCT account materializes the hash with BOTH accounts + a 30d TTL', async () => {
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

describe('linkAccount — materialize is ATOMIC (no TTL-less key window)', () => {
  it('materializes the BOTH-accounts set via a SINGLE atomic hSetMultiWithExpire call', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await linkAccount(DEVICE, 200, 100);

    // The whole point of the hardening: the field-writes + TTL go out as ONE op, so a process death
    // between an hSet and the expire can't leave a TTL-less key. Assert the non-atomic primitives are
    // NEVER used on the create path (a regression to hSet→hSet→expire would re-open the orphan window).
    expect(sys.hSetMultiWithExpire).toHaveBeenCalledTimes(1);
    expect(sys.hSetMultiWithExpire).toHaveBeenCalledWith(
      KEY,
      [String(100), expect.any(String), String(200), expect.any(String)],
      DEVICE_TTL_S
    );
    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
  });

  it('never leaves a key whose TTL was not set: every materialized key has a recorded TTL', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await linkAccount(DEVICE, 200, 100);

    // The atomic op sets fields AND ttl together. So any key that exists in the store MUST also have a
    // TTL recorded — there is no interleaving in which the key is created without one.
    expect(sys._store.has(KEY)).toBe(true);
    expect(sys._ttl.has(KEY)).toBe(true);
    expect(sys._ttl.get(KEY)).toBe(DEVICE_TTL_S);
  });

  it('a redis throw on the atomic op is swallowed (best-effort) and resolves', async () => {
    const sys = makeSys();
    sys.hSetMultiWithExpire.mockRejectedValueOnce(new Error('redis blip'));
    h.getSysRedis.mockReturnValue(sys);

    // A blip during materialize must not fail the login it rides on. And because the field-writes and TTL
    // were a single op, a failed attempt leaves NO key at all (not a TTL-less one).
    await expect(linkAccount(DEVICE, 200, 100)).resolves.toBeUndefined();
    expect(sys._store.has(KEY)).toBe(false);
  });
});

describe('refresh-only paths create ZERO keys (coverage-gap guarantee)', () => {
  // Pin the lazy-materialization invariant at the caller granularity: the refresh paths (touchAccount,
  // isLinkedAndFresh, listAccounts, removeAccount) must NEVER issue a field-creating write against a
  // non-existent set — only linkAccount may create the `device:accounts:*` key. A future change that
  // started writing a singleton through any of these would re-grow the keyspace this PR shrank.
  it('touchAccount on a non-existent set issues NO hSet / hSetMultiWithExpire / expire', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    await touchAccount(DEVICE, 100);

    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.hSetMultiWithExpire).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    expect(sys._store.has(KEY)).toBe(false);
  });

  it('isLinkedAndFresh / listAccounts / removeAccount on a non-existent set create no key', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);

    expect(await isLinkedAndFresh(DEVICE, 100)).toBe(false);
    expect(await listAccounts(DEVICE)).toEqual([]);
    await removeAccount(DEVICE, 100);

    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.hSetMultiWithExpire).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    expect(sys._store.has(KEY)).toBe(false);
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

  // THE DRAIN FIX (core of this PR): an EXISTING single-account (hlen=1) set must NOT be refreshed. The old
  // `exists`-gated code WOULD have re-`expire`d it, re-rolling the 30d TTL on every login → the ~7.9M legacy
  // single-account keys never drained. Gating on hLen<2 lets those keys (and any 2→1 remnant) expire naturally.
  it('does NOT refresh an EXISTING single-account (hlen=1) set — lets legacy singletons drain', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    // Simulate a pre-existing legacy single-account key (written before lazy-materialization) with a TTL.
    const seededTs = String(Date.now() - 60_000);
    sys._store.set(KEY, new Map([['100', seededTs]]));
    sys._ttl.set(KEY, 12345); // an arbitrary already-set TTL we must NOT touch
    vi.clearAllMocks();

    await touchAccount(DEVICE, 100);

    // No write of any kind — the singleton must be left to expire.
    expect(sys.hLen).toHaveBeenCalledWith(KEY);
    expect(sys.hSet).not.toHaveBeenCalled();
    expect(sys.hSetMultiWithExpire).not.toHaveBeenCalled();
    expect(sys.expire).not.toHaveBeenCalled();
    // TTL untouched (no roll), field value untouched.
    expect(sys._ttl.get(KEY)).toBe(12345);
    expect(sys._store.get(KEY)!.get('100')).toBe(seededTs);
  });

  it('refreshes lastSwitchedAt + rolls the 30d TTL when the set is multi-account (hlen ≥ 2)', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    // Seed an existing multi-account set (hlen = 2) so the refresh path is exercised.
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

  it('isLinkedAndFresh rejects an account idle longer than the TTL', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    // Backdate account 100 to just past the idle window (TTL + 1 day) — robust to the TTL value.
    await sys.hSet(KEY, '100', String(Date.now() - (DEVICE_TTL_S * 1000 + 24 * 60 * 60 * 1000)));

    expect(await isLinkedAndFresh(DEVICE, 100)).toBe(false);
    expect(await isLinkedAndFresh(DEVICE, 200)).toBe(true);
  });

  it('listAccounts prunes accounts idle past the TTL', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    await sys.hSet(KEY, '100', String(Date.now() - (DEVICE_TTL_S * 1000 + 24 * 60 * 60 * 1000))); // stale

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
  it('uses a 30-day device TTL (matches AUTH_SESSION_MAX_AGE; keyspace bounded by lazy-create, not the TTL)', async () => {
    const sys = makeSys();
    h.getSysRedis.mockReturnValue(sys);
    await linkAccount(DEVICE, 200, 100);
    expect(sys._ttl.get(KEY)).toBe(DEVICE_TTL_S);
  });
});
