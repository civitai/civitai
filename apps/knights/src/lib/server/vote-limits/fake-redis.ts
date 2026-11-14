import { LuaFactory } from 'wasmoon';
import type { GateClient } from './gate';

type Entry = { value: string; expiresAt: number | null };

/**
 * The gate's Redis for tests: its scripts run for real, in Lua (wasmoon), over an in-memory store with a clock the test
 * moves. Supports the commands the scripts use: GET, SET (PX), INCR, DECR, PEXPIRE, PTTL, DEL.
 */
export function fakeRedis() {
  const factory = new LuaFactory();
  const clock = { now: 0 };
  const values = new Map<string, Entry>();
  const calls: string[][] = [];
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock.now) values.delete(key);
    return values.get(key);
  };
  const add = (key: string, by: number) => {
    const next = Number(live(key)?.value ?? 0) + by;
    values.set(key, { value: String(next), expiresAt: live(key)?.expiresAt ?? null });
    return next;
  };

  function call(name: string, ...args: unknown[]): unknown {
    const command = name.toUpperCase();
    const [key, ...rest] = args.map(String);
    calls.push([command, key, ...rest]);
    switch (command) {
      case 'GET':
        return live(key)?.value ?? false;
      case 'SET': {
        const px = rest.findIndex((a) => a.toUpperCase() === 'PX');
        values.set(key, {
          value: rest[0],
          expiresAt: px === -1 ? null : clock.now + Number(rest[px + 1]),
        });
        return 'OK';
      }
      case 'INCR':
        return add(key, 1);
      case 'DECR':
        return add(key, -1);
      case 'PEXPIRE': {
        const entry = live(key);
        if (entry) entry.expiresAt = clock.now + Number(rest[0]);
        return entry ? 1 : 0;
      }
      case 'PTTL': {
        const entry = live(key);
        if (!entry) return -2;
        return entry.expiresAt === null ? -1 : entry.expiresAt - clock.now;
      }
      case 'DEL':
        return values.delete(key) ? 1 : 0;
      default:
        throw new Error(`fake redis: ${command} is not supported`);
    }
  }

  const client: GateClient = {
    // A fresh engine per eval, like Redis's clean script environment.
    async eval(script, { keys, arguments: argv }) {
      const engine = await factory.createEngine();
      try {
        await engine.doString('unpack = table.unpack');
        engine.global.set('KEYS', keys);
        engine.global.set('ARGV', argv);
        engine.global.set('redis', { call });
        return await engine.doString(script);
      } finally {
        engine.global.close();
      }
    },
    async pTTL(key) {
      return call('PTTL', key) as number;
    },
  };

  return {
    client,
    clock,
    values,
    calls,
    /** The live value at `key`, or undefined. */
    get: (key: string) => live(key)?.value,
    /** Remaining ms to live, -2 if missing, -1 if it has no TTL. */
    pttl: (key: string) => call('PTTL', key) as number,
    /** Seeds `key`, as a test's starting data. */
    seed: (key: string, value: string, ttlMs: number | null = null) =>
      values.set(key, { value, expiresAt: ttlMs === null ? null : clock.now + ttlMs }),
  };
}
