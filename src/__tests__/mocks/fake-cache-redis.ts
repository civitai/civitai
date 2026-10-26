import { pack, unpack } from 'msgpackr';
import { redisMock } from './redis.mock';

type SetOptions = {
  EX?: number;
  PX?: number;
  PXAT?: number;
  NX?: boolean;
  XX?: boolean;
  KEEPTTL?: boolean;
};
type Stored = { value: Buffer; expiresAt: number | null };

/**
 * A key/value store with expiry behind the cache-cluster `redis` mock's `get`/`set`/`del`, plain
 * and `packed`, for tests that need a cache to actually hold what it wrote. Expiry reads
 * `Date.now()`, so fake timers drive it. `EX` and `PX` count from the call, `PXAT` is absolute. `NX` and `XX`
 * answer `null` the way Redis does.
 *
 * Values are stored msgpack-PACKED and unpacked on every read, as the real `packed` codec does, so
 * every read hands back a fresh object: a caller mutating what it got cannot reach the next reader
 * through the fake when it could not through Redis.
 *
 * Call `install()` in a `beforeEach` (after any mock reset); it returns the store so a test can
 * read or seed raw entries.
 */
export function installFakeCacheRedis() {
  const store = new Map<string, Stored>();

  const read = (key: string) => {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return unpack(hit.value);
  };

  const write = (key: string, value: unknown, options: SetOptions = {}) => {
    const existing = read(key);
    if (options.NX && existing !== null) return null;
    if (options.XX && existing === null) return null;
    const previous = store.get(key);
    // A relative EX/PX counts from when the command ARRIVES (this call); PXAT is an absolute instant, so
    // one already in the past stores a key that is expired on arrival, as Redis does.
    const expiresAt =
      options.PXAT !== undefined
        ? options.PXAT
        : options.EX
        ? Date.now() + options.EX * 1000
        : options.PX
        ? Date.now() + options.PX
        : options.KEEPTTL
        ? previous?.expiresAt ?? null
        : null;
    store.set(key, { value: pack(value), expiresAt });
    return 'OK';
  };

  const del = (keys: string | string[]) => {
    let n = 0;
    for (const key of [keys].flat()) if (store.delete(key)) n++;
    return n;
  };

  // The hybrid mock's nodes are vivified spies at any depth; typing each one buys nothing here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = redisMock.redis as unknown as Record<string, any>;
  r.packed.get.mockImplementation(async (key: string) => read(key));
  r.packed.mGet.mockImplementation(async (keys: string[]) => keys.map(read));
  r.packed.set.mockImplementation(async (key: string, value: unknown, options?: SetOptions) =>
    write(key, value, options)
  );
  r.get.mockImplementation(async (key: string) => read(key));
  r.set.mockImplementation(async (key: string, value: unknown, options?: SetOptions) =>
    write(key, value, options)
  );
  r.del.mockImplementation(async (keys: string | string[]) => del(keys));
  r.setNxKeepTtlWithEx.mockImplementation(async (key: string, value: string, ttl: number) => {
    if (read(key) !== null) return false;
    write(key, value, { EX: ttl });
    return true;
  });

  return Object.assign(store, {
    /** The decoded value at `key`, ignoring expiry (null when absent). */
    peek: (key: string) => {
      const hit = store.get(key);
      return hit ? unpack(hit.value) : null;
    },
    /** Write a raw entry, as another writer would. */
    plant: (key: string, value: unknown, ttlSeconds: number) =>
      write(key, value, { EX: ttlSeconds }),
  });
}
