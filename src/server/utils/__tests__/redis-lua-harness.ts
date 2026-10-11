import { LuaFactory } from 'wasmoon';

/**
 * Executes a Redis EVAL script for real, in Lua (wasmoon, Lua 5.4), against an in-memory store
 * with a settable clock, so a script's arithmetic and its redis.call sequence are tested rather
 * than mocked. CI has no Redis server.
 *
 * Supports only the commands the scripts under test use: TIME, HMGET, HSET, PEXPIRE, DEL. It is
 * deliberately stricter than Redis in two places that would otherwise hide a 5.1/5.4 divergence:
 * every redis.call argument must already be a string (so a script must format its own numbers),
 * and every number it returns must be an integer (Redis would silently truncate a float).
 */
export type LuaRedis = {
  nowMs: number;
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  /** The live hash at `key` (after expiry), or undefined. */
  hash: (key: string) => Record<string, string> | undefined;
  /** Remaining ms until `key` expires, -2 if missing, -1 if it has no TTL. */
  pttl: (key: string) => number;
  /** Every redis.call issued, as [command, ...args]. */
  calls: string[][];
  /**
   * Every error an eval threw. The code under test fails OPEN on a redis error, so a broken
   * script would read as "allowed" — assert this stays empty.
   */
  errors: unknown[];
};

export function createLuaRedis(startMs: number): LuaRedis {
  const factory = new LuaFactory();
  const hashes = new Map<string, Map<string, string>>();
  const expiresAt = new Map<string, number>();
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
        engine.global.set('KEYS', keys);
        engine.global.set('ARGV', argv);
        engine.global.set('redis', { call: redisCall });
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
    pttl: (key) => {
      expire(key);
      if (!hashes.has(key)) return -2;
      const at = expiresAt.get(key);
      return at === undefined ? -1 : at - state.nowMs;
    },
  };

  function expire(key: string) {
    const at = expiresAt.get(key);
    if (at !== undefined && at <= state.nowMs) {
      hashes.delete(key);
      expiresAt.delete(key);
    }
  }

  function redisCall(command: string, ...args: unknown[]) {
    for (const a of args) {
      if (typeof a !== 'string') {
        throw new Error(`redis.call(${command}): argument ${String(a)} is a ${typeof a}`);
      }
    }
    const strArgs = args as string[];
    calls.push([command, ...strArgs]);
    const key = strArgs[0];
    if (key !== undefined) expire(key);
    switch (command) {
      case 'TIME':
        return [
          String(Math.floor(state.nowMs / 1000)),
          String(Math.floor(state.nowMs % 1000) * 1000),
        ];
      case 'HMGET': {
        const h = hashes.get(key);
        return strArgs.slice(1).map((f) => h?.get(f) ?? false);
      }
      case 'HSET': {
        const h = hashes.get(key) ?? new Map<string, string>();
        for (let i = 1; i < strArgs.length; i += 2) h.set(strArgs[i], strArgs[i + 1]);
        hashes.set(key, h);
        return 1;
      }
      case 'PEXPIRE': {
        if (!hashes.has(key)) return 0;
        expiresAt.set(key, state.nowMs + Number(strArgs[1]));
        return 1;
      }
      case 'DEL': {
        const existed = hashes.delete(key);
        expiresAt.delete(key);
        return existed ? 1 : 0;
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
