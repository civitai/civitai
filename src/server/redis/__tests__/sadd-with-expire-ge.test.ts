import { describe, it, expect, vi } from 'vitest';
import { sAddWithExpireGe } from '../atomic';

/**
 * Tests for the tRPC tag-cache atomic SADD+floor-TTL helper.
 *
 * Two layers:
 *  - BOUNDARY: assert the helper hands `client.eval` the exact script + KEYS +
 *    ARGV shape (mirrors atomic.test.ts). Pins the Lua so the semantic fake
 *    below can't silently drift from the real script.
 *  - SEMANTIC: a stateful in-memory Redis fake (SADD/TTL/EXPIRE/SMEMBERS/DEL +
 *    a virtual clock) whose `eval` executes the helper's Lua semantics. Proves:
 *      (1) a repeat write for an already-present tag member does NOT re-issue
 *          the server-side EXPIRE, and every write costs exactly ONE command;
 *      (2) the invariant TTL(tagSet) >= max(member TTL) holds across new-tag,
 *          decayed-tag, and shorter-after-longer scenarios (never shortened);
 *      (3) a tag bust still removes every live member.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Boundary: script + ARGV wiring
// ─────────────────────────────────────────────────────────────────────────────

function evalSpy() {
  return { eval: vi.fn().mockResolvedValue(1) };
}

describe('sAddWithExpireGe — eval wiring', () => {
  it('passes key as KEYS[1], member+ttl as ARGV, and a SADD/TTL/conditional-EXPIRE script', async () => {
    const client = evalSpy();
    await sAddWithExpireGe(client, 'caches:tagged-cache:leaderboard-3', 'trpc:x:abc', 86400);

    expect(client.eval).toHaveBeenCalledTimes(1);
    const [script, options] = client.eval.mock.calls[0];

    // SADD the member, read TTL, and EXPIRE only when below the floor.
    expect(script).toContain("redis.call('SADD', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('TTL', KEYS[1])");
    expect(script).toContain('if cur < ttl then');
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ttl)");
    // Returns SADD's reply (newly-added count), not a constant.
    expect(script).toContain('return added');

    expect(options.keys).toEqual(['caches:tagged-cache:leaderboard-3']);
    expect(options.arguments).toEqual(['trpc:x:abc', '86400']);
  });

  it('returns SADD reply (newly-added count) coerced to a number', async () => {
    const client = { eval: vi.fn().mockResolvedValue(0) };
    await expect(sAddWithExpireGe(client, 'k', 'm', 100)).resolves.toBe(0);

    const client2 = { eval: vi.fn().mockResolvedValue(1) };
    await expect(sAddWithExpireGe(client2, 'k', 'm', 100)).resolves.toBe(1);
  });

  it('throws on non-positive / non-finite ttlSeconds and never calls EVAL', async () => {
    const client = evalSpy();
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      await expect(sAddWithExpireGe(client, 'k', 'm', bad)).rejects.toThrow(
        /positive finite number/
      );
    }
    expect(client.eval).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic fake: models Redis SET + key TTLs + a virtual clock.
// ─────────────────────────────────────────────────────────────────────────────

type Entry = { members?: Set<string>; isString?: boolean; expireAt?: number };

class FakeRedis {
  private store = new Map<string, Entry>();
  now = 0; // virtual clock in ms
  /** Count of server-side EXPIRE ops the script actually performed. */
  expireCalls = 0;
  /** Count of node-redis commands issued from JS (each helper call = 1 eval). */
  evalCalls = 0;

  /** Resolve an entry, lazily evicting it if its TTL has elapsed. */
  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt !== undefined && e.expireAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  private sadd(key: string, member: string): number {
    let e = this.live(key);
    if (!e) {
      e = { members: new Set() };
      this.store.set(key, e); // fresh set: no expiry (TTL == -1)
    }
    if (!e.members) e.members = new Set();
    if (e.members.has(member)) return 0;
    e.members.add(member);
    return 1;
  }

  /** Redis TTL semantics: -2 missing, -1 no-expiry, else whole seconds remaining. */
  ttl(key: string): number {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expireAt === undefined) return -1;
    return Math.ceil((e.expireAt - this.now) / 1000);
  }

  private expire(key: string, seconds: number): boolean {
    const e = this.live(key);
    if (!e) return false;
    e.expireAt = this.now + seconds * 1000;
    return true;
  }

  /** Model a tagged DATA key written with `SET ... EX seconds`. */
  setKey(key: string, seconds: number) {
    this.store.set(key, { isString: true, expireAt: this.now + seconds * 1000 });
  }

  sMembers(key: string): string[] {
    const e = this.live(key);
    return e?.members ? [...e.members] : [];
  }

  del(keys: string | string[]): number {
    const arr = Array.isArray(keys) ? keys : [keys];
    let n = 0;
    for (const k of arr) {
      if (this.live(k)) n++;
      this.store.delete(k);
    }
    return n;
  }

  exists(key: string): boolean {
    return this.live(key) !== undefined;
  }

  advance(ms: number) {
    this.now += ms;
  }

  /**
   * Executes the exact semantics of sAddWithExpireGe's Lua script. The boundary
   * test above pins the real script's ops so this stays faithful.
   */
  async eval(_script: string, opts: { keys: string[]; arguments: string[] }): Promise<number> {
    this.evalCalls += 1;
    const key = opts.keys[0];
    const member = opts.arguments[0];
    const ttl = Number(opts.arguments[1]);
    const added = this.sadd(key, member);
    const cur = this.ttl(key);
    if (cur < ttl) {
      this.expire(key, ttl);
      this.expireCalls += 1;
    }
    return added;
  }
}

const TAG = 'caches:tagged-cache:leaderboard-3';

describe('sAddWithExpireGe — command volume (redundant EXPIRE elimination)', () => {
  it('does NOT re-issue EXPIRE for a repeat write of an already-present member', async () => {
    const r = new FakeRedis();
    const TTL = 100; // seconds

    // t=0: first member — fresh set (TTL -1 < 100) → EXPIRE fires.
    await sAddWithExpireGe(r, TAG, 'K1', TTL);
    expect(r.expireCalls).toBe(1);
    expect(r.ttl(TAG)).toBe(100);

    // t=50s: a second, distinct member — set has decayed to 50 < 100 → EXPIRE
    // fires and re-floors the set to 100 (now expires at t=150s).
    r.advance(50_000);
    const addedK2 = await sAddWithExpireGe(r, TAG, 'K2', TTL);
    expect(addedK2).toBe(1);
    expect(r.expireCalls).toBe(2);
    expect(r.ttl(TAG)).toBe(100);

    // t=50s: repeat write for the already-present K1 — the set's TTL is already
    // at the floor (100), so the server-side EXPIRE is SKIPPED (the redundancy
    // the old unconditional pair paid on every write).
    const addedK1repeat = await sAddWithExpireGe(r, TAG, 'K1', TTL);
    expect(addedK1repeat).toBe(0); // already a member
    expect(r.expireCalls).toBe(2); // <-- no re-issue

    // Every write cost exactly ONE node-redis command (the eval); there is no
    // separate `expire` command anymore.
    expect(r.evalCalls).toBe(3);
  });
});

describe('sAddWithExpireGe — TTL invariant (tagSet TTL >= member TTL)', () => {
  it('new tag: floors the fresh set to the member TTL', async () => {
    const r = new FakeRedis();
    r.setKey('K1', 100); // the data key, EX 100
    await sAddWithExpireGe(r, TAG, 'K1', 100);
    expect(r.ttl(TAG)).toBe(100);
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(r.ttl('K1')); // invariant
  });

  it('decayed tag: raises an existing shorter TTL back up to the floor', async () => {
    const r = new FakeRedis();
    await sAddWithExpireGe(r, TAG, 'K1', 100); // set expires at t=100s
    r.advance(60_000); // t=60s, set TTL decayed to 40
    r.setKey('K2', 100);
    await sAddWithExpireGe(r, TAG, 'K2', 100); // 40 < 100 → raise to 100
    expect(r.ttl(TAG)).toBe(100);
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(r.ttl('K2')); // invariant
  });

  it('shorter member AFTER a longer one does NOT shorten the set', async () => {
    const r = new FakeRedis();
    // A hypothetical longer-TTL middleware sharing the tag writes first.
    r.setKey('M_long', 1000);
    await sAddWithExpireGe(r, TAG, 'M_long', 1000); // set → 1000
    expect(r.ttl(TAG)).toBe(1000);

    // A shorter-TTL write for the same tag must NOT drop the set to 100 (the
    // old unconditional EXPIRE bug). cur(1000) >= 100 → EXPIRE skipped.
    r.setKey('M_short', 100);
    const before = r.expireCalls;
    await sAddWithExpireGe(r, TAG, 'M_short', 100);
    expect(r.ttl(TAG)).toBe(1000); // NOT shortened
    expect(r.expireCalls).toBe(before); // skipped
    // Invariant holds for BOTH members.
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(r.ttl('M_long'));
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(r.ttl('M_short'));
  });

  it('longer member AFTER a shorter one raises the set to cover it', async () => {
    const r = new FakeRedis();
    r.setKey('M_short', 100);
    await sAddWithExpireGe(r, TAG, 'M_short', 100); // set → 100
    r.setKey('M_long', 1000);
    await sAddWithExpireGe(r, TAG, 'M_long', 1000); // 100 < 1000 → raise to 1000
    expect(r.ttl(TAG)).toBe(1000);
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(r.ttl('M_long')); // invariant
  });
});

/** Reproduce redis.purgeTags: read the set's members, delete the set + members. */
function bustTag(r: FakeRedis, tagKey: string) {
  const members = r.sMembers(tagKey);
  r.del(tagKey);
  r.del(members);
}

describe('sAddWithExpireGe — tag bust still removes all live members', () => {
  it('removes every member key of an all-equal-TTL tag', async () => {
    const r = new FakeRedis();
    for (const k of ['K1', 'K2', 'K3']) {
      r.setKey(k, 100);
      await sAddWithExpireGe(r, TAG, k, 100);
    }
    expect(r.ttl(TAG)).toBeGreaterThanOrEqual(100); // invariant

    bustTag(r, TAG);

    expect(r.exists(TAG)).toBe(false);
    expect(r.exists('K1')).toBe(false);
    expect(r.exists('K2')).toBe(false);
    expect(r.exists('K3')).toBe(false);
  });

  it('never-shorten keeps the set alive long enough to bust a long member (the stale-cache guard)', async () => {
    const r = new FakeRedis();
    // DANGEROUS ordering for the OLD code: long member first (set→1000), then a
    // short-TTL write. The old unconditional EXPIRE would drop the set to 100s,
    // so a bust at t=500s would find the set already gone and MISS M_long →
    // stale cache. The floor guard keeps the set at 1000s.
    r.setKey('M_long', 1000);
    await sAddWithExpireGe(r, TAG, 'M_long', 1000);
    r.setKey('M_short', 100);
    await sAddWithExpireGe(r, TAG, 'M_short', 100);

    r.advance(500_000); // t=500s: M_short expired; M_long + tag set still live
    expect(r.exists('M_short')).toBe(false);
    expect(r.exists('M_long')).toBe(true);
    expect(r.exists(TAG)).toBe(true); // set outlived the short member — invariant

    bustTag(r, TAG);
    // The long member is caught by the bust and purged; nothing left stale.
    expect(r.exists('M_long')).toBe(false);
    expect(r.exists(TAG)).toBe(false);
  });
});
