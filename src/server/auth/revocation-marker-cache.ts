import type { SessionRegistryRedis } from '@civitai/auth';

/**
 * A per-process copy of the session revocation markers this pod has READ from sysRedis, so that a
 * revocation it has already seen still holds while sysRedis is unreachable.
 *
 * It sits UNDER the package's session registry rather than beside it: `observe()` wraps the real
 * client and records what each marker read returns, and `reader()` is a client that answers the same
 * reads from that record. The verifier builds a second registry over `reader()` and asks it the same
 * question, so the degraded verdict comes from the registry's own `isRevoked` predicate. There is no
 * second copy of the rules to drift from the first.
 *
 * What it records:
 *   - a hash field (token or family state) only when its value is `invalid`. A `refresh` marker is not a
 *     revocation, and recording one per refreshed token would push real revocations out of the cache.
 *   - a plain key (the global cut-off, a user's cut, an impersonator's cut) whenever it has a value. These
 *     are timestamps, and the registry compares them with each token's signing time.
 *   - a read that comes back without a marker DELETES the entry, so the record follows sysRedis rather than
 *     holding a marker sysRedis no longer has.
 *
 * What it does NOT know: a marker written while this pod never read it. It is a record of what was seen
 * here, not a replica, so with sysRedis down an unseen revocation is still not applied. The caller decides
 * what to do about that (today: allow, and count it).
 *
 * Bounded both ways: at most `maxEntries` entries, least recently read evicted first, and each entry
 * expires `ttlMs` after the read that last recorded it. Recording is synchronous and in-memory; the
 * wrapped client adds no network call.
 */
export interface RevocationMarkerCache {
  /** Wraps the real client: every hGet/get is passed through unchanged and its result recorded. */
  observe(redis: RevocationReadRedis): SessionRegistryRedis;
  /** A client that answers hGet/get from the record alone. It never touches the network. */
  reader(): SessionRegistryRedis;
  /** Entries currently held, expired ones included until they are next touched. */
  readonly size: number;
}

/** The two reads the registry's `isRevoked` makes. */
export type RevocationReadRedis = Pick<SessionRegistryRedis, 'hGet' | 'get'>;

export interface RevocationMarkerCacheOptions {
  maxEntries: number;
  ttlMs: number;
  /** Clock injection (tests). */
  now?: () => number;
}

// Hash keys and field names never contain NUL, so a hash entry cannot collide with a plain key.
const hashEntry = (key: string, field: string) => `${key}\u0000${field}`;

function asString(value: unknown): string | null {
  if (value == null) return null;
  // The HA sys client returns string replies as Buffers, as the registry notes.
  return typeof value === 'string' ? value : String(value);
}

const readOnly = () => {
  throw new Error('revocation marker cache: read-only client');
};

export function createRevocationMarkerCache(
  options: RevocationMarkerCacheOptions
): RevocationMarkerCache {
  const { maxEntries, ttlMs } = options;
  const now = options.now ?? (() => Date.now());
  // A Map iterates in insertion order, so re-inserting on every touch keeps the first key the least
  // recently used one.
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function record(entry: string, value: string | null) {
    entries.delete(entry);
    if (value == null) return;
    entries.set(entry, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function lookup(entry: string): string | null {
    const hit = entries.get(entry);
    if (!hit) return null;
    entries.delete(entry);
    if (hit.expiresAt <= now()) return null;
    entries.set(entry, hit);
    return hit.value;
  }

  const unsupported = {
    hSet: readOnly,
    hDel: readOnly,
    set: readOnly,
  };

  return {
    observe(redis) {
      return {
        ...unsupported,
        async hGet(key, field) {
          const value = asString(await redis.hGet(key, field));
          record(hashEntry(key, field), value === 'invalid' ? value : null);
          return value;
        },
        async get(key) {
          const value = asString(await redis.get(key));
          record(key, value);
          return value;
        },
      };
    },
    reader() {
      return {
        ...unsupported,
        async hGet(key, field) {
          return lookup(hashEntry(key, field));
        },
        async get(key) {
          return lookup(key);
        },
      };
    },
    get size() {
      return entries.size;
    },
  };
}
