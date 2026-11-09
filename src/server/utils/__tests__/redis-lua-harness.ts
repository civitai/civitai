import { LuaFactory } from 'wasmoon';

/**
 * Executes a Redis EVAL script for real, in Lua (wasmoon, Lua 5.4), against an in-memory store
 * with a settable clock, so a script's arithmetic and its redis.call sequence are tested rather
 * than mocked. CI has no Redis server.
 *
 * Supports only the commands the scripts under test use: TIME, EXISTS, GET, SET (NX, EX, PX), HGET, HEXISTS, HLEN, HMGET, HSET, HDEL, HINCRBY, PEXPIRE,
 * HPEXPIRE, EXPIRE, TTL, DEL, LRANGE, LSET, SADD, SCARD, SISMEMBER, SREM, SMEMBERS, ZADD, ZREM,
 * ZRANGE (BYSCORE, REV, LIMIT, WITHSCORES), ZUNIONSTORE (sum), and redis.error_reply (thrown, as the client would). It is deliberately stricter than Redis in two places that would otherwise hide a 5.1/5.4 divergence:
 * every redis.call argument must already be a string (so a script must format its own numbers),
 * and every number it returns must be an integer (Redis would silently truncate a float).
 * `integerArgs` relaxes the first for scripts whose numeric arguments are literals or `ipairs`
 * indices: integers format the same in both Lua versions, so only a non-integer still throws.
 */
export type LuaRedis = {
  nowMs: number;
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  /** The live hash at `key` (after expiry), or undefined. */
  hash: (key: string) => Record<string, string> | undefined;
  /** Remaining ms until `key` expires, -2 if missing, -1 if it has no TTL. */
  pttl: (key: string) => number;
  /** Remaining ms until hash field `field` expires (HPEXPIRE), -2 if missing, -1 if it has no TTL. */
  hpttl: (key: string, field: string) => number;
  /** Replaces the hash at `key`, as a test's starting data. */
  setHash: (key: string, fields: Record<string, string>) => void;
  /** The members of the set at `key` (after expiry), or undefined. */
  set: (key: string) => string[] | undefined;
  /** Replaces the set at `key`, as a test's starting data. */
  setSet: (key: string, members: string[]) => void;
  /** The sorted set at `key` (after expiry) as member -> score, or undefined. */
  zset: (key: string) => Record<string, number> | undefined;
  /** The string at `key` (after expiry), or undefined. */
  string: (key: string) => string | undefined;
  /** Replaces the string at `key`, as a test's starting data, expiring in `ttlMs` when given. */
  setString: (key: string, value: string, ttlMs?: number) => void;
  /** The list at `key`, head first, or undefined. */
  list: (key: string) => string[] | undefined;
  /** Replaces the list at `key` (head first), as a test's starting data. */
  setList: (key: string, items: string[]) => void;
  /** Every redis.call issued, as [command, ...args]. */
  calls: string[][];
  /**
   * Every error an eval threw. The code under test fails OPEN on a redis error, so a broken
   * script would read as "allowed" — assert this stays empty.
   */
  errors: unknown[];
};

export function createLuaRedis(
  startMs: number,
  {
    integerArgs = false,
    strings = new Map<string, string>(),
  }: {
    integerArgs?: boolean;
    /**
     * The plain string keys GET/SET read and write. Pass a test's own map to run a script over
     * the same keys its fake client's `get`/`set`/`del` serve.
     */
    strings?: Map<string, string>;
  } = {}
): LuaRedis {
  const factory = new LuaFactory();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expiresAt = new Map<string, number>();
  const fieldExpiresAt = new Map<string, Map<string, number>>();
  const calls: string[][] = [];
  const errors: unknown[] = [];

  const state: LuaRedis = {
    nowMs: startMs,
    calls,
    errors,
    // A fresh engine per eval, like Redis's clean script environment. It is also load-bearing:
    // one long-lived wasmoon engine corrupts its heap ("memory access out of bounds") after a
    // few dozen JS-returned tables.
    eval: async (script, { keys, arguments: argv }) => {
      const engine = await factory.createEngine();
      try {
        // Redis runs Lua 5.1, where `unpack` is a global; 5.4 only has table.unpack.
        await engine.doString('unpack = table.unpack');
        engine.global.set('KEYS', keys);
        engine.global.set('ARGV', argv);
        engine.global.set('redis', {
          call: redisCall,
          error_reply: (message: string) => {
            throw new Error(message);
          },
        });
        return toRedisReply(await engine.doString(script));
      } catch (err) {
        errors.push(err);
        throw err;
      } finally {
        engine.global.close();
      }
    },
    hash: (key) => {
      expire(key);
      const h = hashes.get(key);
      return h ? Object.fromEntries(h) : undefined;
    },
    setHash: (key, fields) => {
      hashes.set(key, new Map(Object.entries(fields)));
      expiresAt.delete(key);
      fieldExpiresAt.delete(key);
    },
    set: (key) => {
      expire(key);
      const members = sets.get(key);
      return members ? [...members] : undefined;
    },
    setSet: (key, members) => {
      sets.set(key, new Set(members));
      expiresAt.delete(key);
    },
    zset: (key) => {
      expire(key);
      const z = zsets.get(key);
      return z ? Object.fromEntries(z) : undefined;
    },
    string: (key) => {
      expire(key);
      return strings.get(key);
    },
    setString: (key, value, ttlMs) => {
      strings.set(key, value);
      if (ttlMs === undefined) expiresAt.delete(key);
      else expiresAt.set(key, state.nowMs + ttlMs);
    },
    list: (key) => {
      const l = lists.get(key);
      return l ? [...l] : undefined;
    },
    setList: (key, items) => {
      lists.set(key, [...items]);
    },
    hpttl: (key, field) => {
      expire(key);
      if (!hashes.get(key)?.has(field)) return -2;
      const at = fieldExpiresAt.get(key)?.get(field);
      return at === undefined ? -1 : at - state.nowMs;
    },
    pttl: (key) => {
      expire(key);
      if (!exists(key)) return -2;
      const at = expiresAt.get(key);
      return at === undefined ? -1 : at - state.nowMs;
    },
  };

  function exists(key: string) {
    return hashes.has(key) || sets.has(key) || zsets.has(key) || lists.has(key) || strings.has(key);
  }

  function expire(key: string) {
    const at = expiresAt.get(key);
    if (at !== undefined && at <= state.nowMs) {
      sets.delete(key);
      zsets.delete(key);
      hashes.delete(key);
      strings.delete(key);
      expiresAt.delete(key);
      fieldExpiresAt.delete(key);
    }
    const fieldTtls = fieldExpiresAt.get(key);
    const h = hashes.get(key);
    if (!fieldTtls || !h) return;
    for (const [field, fieldAt] of fieldTtls) {
      if (fieldAt > state.nowMs) continue;
      h.delete(field);
      fieldTtls.delete(field);
    }
    if (!h.size) hashes.delete(key);
  }

  function redisCall(name: string, ...args: unknown[]) {
    // Redis reads command names in any case.
    const command = name.toUpperCase();
    const strArgs = args.map((a) => {
      if (typeof a === 'string') return a;
      if (integerArgs && typeof a === 'number' && Number.isInteger(a)) return String(a);
      throw new Error(`redis.call(${command}): argument ${String(a)} is a ${typeof a}`);
    });
    calls.push([command, ...strArgs]);
    const key = strArgs[0];
    if (key !== undefined) expire(key);
    switch (command) {
      case 'TIME':
        return [
          String(Math.floor(state.nowMs / 1000)),
          String(Math.floor(state.nowMs % 1000) * 1000),
        ];
      case 'GET':
        return strings.get(key) ?? false;
      case 'SET': {
        const opts = strArgs.slice(2).map((a) => a.toUpperCase());
        if (opts.includes('NX') && exists(key)) return false;
        hashes.delete(key);
        sets.delete(key);
        lists.delete(key);
        strings.set(key, strArgs[1]);
        const ex = opts.indexOf('EX');
        const px = opts.indexOf('PX');
        if (ex !== -1) expiresAt.set(key, state.nowMs + Number(strArgs[2 + ex + 1]) * 1000);
        else if (px !== -1) expiresAt.set(key, state.nowMs + Number(strArgs[2 + px + 1]));
        else expiresAt.delete(key);
        return { ok: 'OK' };
      }
      case 'EXISTS':
        return exists(key) ? 1 : 0;
      case 'HGET':
        return hashes.get(key)?.get(strArgs[1]) ?? false;
      case 'HEXISTS':
        return hashes.get(key)?.has(strArgs[1]) ? 1 : 0;
      case 'HLEN':
        return hashes.get(key)?.size ?? 0;
      case 'HINCRBY': {
        const h = hashes.get(key) ?? new Map<string, string>();
        const by = strArgs[2];
        const current = h.get(strArgs[1]) ?? '0';
        if (!/^-?\d+$/.test(by) || !/^-?\d+$/.test(current)) {
          throw new Error('ERR value is not an integer or out of range');
        }
        const next = String(BigInt(current) + BigInt(by));
        h.set(strArgs[1], next);
        hashes.set(key, h);
        return Number(next);
      }
      case 'HMGET': {
        const h = hashes.get(key);
        return strArgs.slice(1).map((f) => h?.get(f) ?? false);
      }
      case 'HSET': {
        const h = hashes.get(key) ?? new Map<string, string>();
        for (let i = 1; i < strArgs.length; i += 2) {
          h.set(strArgs[i], strArgs[i + 1]);
          fieldExpiresAt.get(key)?.delete(strArgs[i]);
        }
        hashes.set(key, h);
        return 1;
      }
      case 'HDEL': {
        const h = hashes.get(key);
        let removed = 0;
        for (const f of strArgs.slice(1)) {
          if (h?.delete(f)) removed++;
          fieldExpiresAt.get(key)?.delete(f);
        }
        if (h && !h.size) hashes.delete(key);
        return removed;
      }
      case 'HPEXPIRE': {
        // HPEXPIRE key ms FIELDS n field [field ...]
        if (strArgs[2] !== 'FIELDS') throw new Error('ERR syntax error');
        const ms = Number(strArgs[1]);
        const fields = strArgs.slice(4, 4 + Number(strArgs[3]));
        const h = hashes.get(key);
        const ttls = fieldExpiresAt.get(key) ?? new Map<string, number>();
        fieldExpiresAt.set(key, ttls);
        return fields.map((f) => {
          if (!h?.has(f)) return -2;
          ttls.set(f, state.nowMs + ms);
          return 1;
        });
      }
      case 'PEXPIRE': {
        if (!exists(key)) return 0;
        expiresAt.set(key, state.nowMs + Number(strArgs[1]));
        return 1;
      }
      case 'EXPIRE': {
        if (!exists(key)) return 0;
        expiresAt.set(key, state.nowMs + Number(strArgs[1]) * 1000);
        return 1;
      }
      case 'TTL': {
        if (!exists(key)) return -2;
        const at = expiresAt.get(key);
        return at === undefined ? -1 : Math.ceil((at - state.nowMs) / 1000);
      }
      case 'SADD': {
        const members = sets.get(key) ?? new Set<string>();
        const before = members.size;
        for (const m of strArgs.slice(1)) members.add(m);
        sets.set(key, members);
        return members.size - before;
      }
      case 'SCARD':
        return sets.get(key)?.size ?? 0;
      case 'SISMEMBER':
        return sets.get(key)?.has(strArgs[1]) ? 1 : 0;
      case 'SMEMBERS':
        return [...(sets.get(key) ?? [])];
      case 'SREM': {
        const members = sets.get(key);
        let removed = 0;
        for (const m of strArgs.slice(1)) if (members?.delete(m)) removed++;
        if (members && !members.size) {
          sets.delete(key);
          expiresAt.delete(key);
        }
        return removed;
      }
      case 'DEL': {
        const existed =
          hashes.delete(key) || sets.delete(key) || zsets.delete(key) || strings.delete(key);
        expiresAt.delete(key);
        return existed ? 1 : 0;
      }
      case 'LRANGE': {
        const l = lists.get(key) ?? [];
        const at = (i: number) => (i < 0 ? l.length + i : i);
        return l.slice(Math.max(at(Number(strArgs[1])), 0), at(Number(strArgs[2])) + 1);
      }
      case 'LSET': {
        const l = lists.get(key);
        if (!l) throw new Error('ERR no such key');
        const raw = Number(strArgs[1]);
        const i = raw < 0 ? l.length + raw : raw;
        if (i < 0 || i >= l.length) throw new Error('ERR index out of range');
        l[i] = strArgs[2];
        return 'OK';
      }
      case 'ZADD': {
        const z = zsets.get(key) ?? new Map<string, number>();
        let added = 0;
        for (let i = 1; i < strArgs.length; i += 2) {
          const score = Number(strArgs[i]);
          if (Number.isNaN(score)) throw new Error('ERR value is not a valid float');
          if (!z.has(strArgs[i + 1])) added++;
          z.set(strArgs[i + 1], score);
        }
        zsets.set(key, z);
        return added;
      }
      case 'ZREM': {
        const z = zsets.get(key);
        let removed = 0;
        for (const m of strArgs.slice(1)) if (z?.delete(m)) removed++;
        if (z && !z.size) {
          zsets.delete(key);
          expiresAt.delete(key);
        }
        return removed;
      }
      case 'ZUNIONSTORE': {
        const n = Number(strArgs[1]);
        if (strArgs.length !== 2 + n) throw new Error('ZUNIONSTORE: only plain sum is supported');
        const out = new Map<string, number>();
        for (const k of strArgs.slice(2, 2 + n)) {
          expire(k);
          for (const [m, score] of zsets.get(k) ?? []) out.set(m, (out.get(m) ?? 0) + score);
        }
        zsets.delete(key);
        expiresAt.delete(key);
        if (out.size) zsets.set(key, out);
        return out.size;
      }
      case 'ZRANGE': {
        const opts = strArgs.slice(3).map((a) => a.toUpperCase());
        if (!opts.includes('BYSCORE')) throw new Error('ZRANGE: only BYSCORE is supported');
        const rev = opts.includes('REV');
        // Redis reads the bounds as max, min under REV.
        const [lo, hi] = rev ? [strArgs[2], strArgs[1]] : [strArgs[1], strArgs[2]];
        const bound = (b: string) => {
          const exclusive = b.startsWith('(');
          const raw = exclusive ? b.slice(1) : b;
          const v =
            raw === '-inf' ? -Infinity : raw === '+inf' || raw === 'inf' ? Infinity : Number(raw);
          if (Number.isNaN(v)) throw new Error('ERR min or max is not a float');
          return { v, exclusive };
        };
        const min = bound(lo);
        const max = bound(hi);
        let rows = [...(zsets.get(key) ?? [])]
          .filter(([, sc]) => (min.exclusive ? sc > min.v : sc >= min.v))
          .filter(([, sc]) => (max.exclusive ? sc < max.v : sc <= max.v))
          .sort(([am, as], [bm, bs]) => as - bs || (am < bm ? -1 : am > bm ? 1 : 0));
        if (rev) rows.reverse();
        const limit = opts.indexOf('LIMIT');
        if (limit !== -1) {
          const offset = Number(strArgs[3 + limit + 1]);
          const count = Number(strArgs[3 + limit + 2]);
          rows = rows.slice(offset, count < 0 ? undefined : offset + count);
        }
        return opts.includes('WITHSCORES')
          ? rows.flatMap(([m, sc]) => [m, String(sc)])
          : rows.map(([m]) => m);
      }
      default:
        throw new Error(`redis.call: ${command} is not supported by the harness`);
    }
  }

  return state;
}

function toRedisReply(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toRedisReply);
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error(`script returned a non-integer number ${value}`);
  }
  return value;
}
