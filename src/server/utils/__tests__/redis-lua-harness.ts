import { LuaFactory } from 'wasmoon';

/**
 * Executes a Redis EVAL script for real, in Lua (wasmoon, Lua 5.4), against an in-memory store
 * with a settable clock, so a script's arithmetic and its redis.call sequence are tested rather
 * than mocked. CI has no Redis server.
 *
 * Supports only the commands the scripts under test use: TIME, EXISTS, HGET, HEXISTS, HLEN, HMGET, HSET, HDEL, HINCRBY, PEXPIRE,
 * HPEXPIRE, EXPIRE, TTL, DEL, LRANGE, LSET, SADD, SCARD, SISMEMBER, SREM, SMEMBERS, and redis.error_reply (thrown, as the client would). It is deliberately stricter than Redis in two places that would otherwise hide a 5.1/5.4 divergence:
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
  { integerArgs = false }: { integerArgs?: boolean } = {}
): LuaRedis {
  const factory = new LuaFactory();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
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
    return hashes.has(key) || sets.has(key) || lists.has(key);
  }

  function expire(key: string) {
    const at = expiresAt.get(key);
    if (at !== undefined && at <= state.nowMs) {
      sets.delete(key);
      hashes.delete(key);
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

  function redisCall(command: string, ...args: unknown[]) {
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
        const existed = hashes.delete(key) || sets.delete(key);
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
