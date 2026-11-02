import { createHash } from 'crypto';
import type { JWTPayload } from 'jose';

// A per-process cache of ES256 signature verifications, so a token presented on many requests pays for
// `jwtVerify` once. It stores ONLY the outcome of the signature + issuer + audience check, which is a pure
// function of the token bytes and the verifier's fixed config. Everything that can change while a token is
// alive — expiry against the clock, the lineage limits and the revocation read — is still evaluated on every
// call by verify.ts, hit or miss. See `claimsCache` in AuthVerifierConfig.

export interface VerifiedClaimsCacheOptions {
  /**
   * The switch, read on EVERY verify. Anything but `true` (including a throw or a rejected promise) means the
   * cache is neither read nor written and verify runs exactly as it does without this option; the entries
   * already held are dropped, so turning it back on starts empty.
   */
  enabled: () => boolean | Promise<boolean>;
  /** Most entries held; the least recently used is dropped past it. Default 10 000. */
  maxEntries?: number;
  /** Longest an entry is served, in ms. The token's own `exp` caps it further. Default 60 000. */
  ttlMs?: number;
}

export const DEFAULT_CLAIMS_CACHE_MAX_ENTRIES = 10_000;
export const DEFAULT_CLAIMS_CACHE_TTL_MS = 60_000;

interface Entry {
  payload: JWTPayload;
  /** Epoch ms after which the entry must not be served: min(insert + ttl, exp * 1000). */
  expiresAt: number;
}

export interface VerifiedClaimsCache {
  /** The verified payload for exactly this token, or undefined. A copy — callers may mutate it. */
  get(token: string): JWTPayload | undefined;
  /** Record a payload that just passed verification. A payload without a numeric `exp` is not stored. */
  set(token: string, payload: JWTPayload): void;
  clear(): void;
  readonly size: number;
}

// The key is a digest of the WHOLE token string (header, payload and signature), never a claim such as `jti`
// or a segment of it: two tokens that differ anywhere get different keys, so one token's claims can never be
// served for another. Hashing also keeps raw bearer tokens out of the heap's long-lived keys.
const keyOf = (token: string) => createHash('sha256').update(token).digest('base64url');

export function createVerifiedClaimsCache(opts: {
  clock: () => number;
  maxEntries?: number;
  ttlMs?: number;
}): VerifiedClaimsCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_CLAIMS_CACHE_MAX_ENTRIES;
  const ttlMs = opts.ttlMs ?? DEFAULT_CLAIMS_CACHE_TTL_MS;
  const map = new Map<string, Entry>(); // insertion order = recency order (oldest first)

  return {
    get(token) {
      const key = keyOf(token);
      const entry = map.get(key);
      if (!entry) return undefined;
      // Expiry on a HIT. jose rejects a token once floor(now / 1000) >= exp, i.e. once now >= exp * 1000;
      // expiresAt is never later than exp * 1000, so an expired token is never served from here.
      if (opts.clock() >= entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      map.delete(key); // move to most-recent
      map.set(key, entry);
      return structuredClone(entry.payload);
    },
    set(token, payload) {
      // A token with no `exp` is never cached: its lifetime would then be bounded by the TTL alone.
      if (typeof payload.exp !== 'number') return;
      const t = opts.clock();
      const expiresAt = Math.min(t + ttlMs, payload.exp * 1000);
      // Written as a negation so a NaN `exp` (which would otherwise make an entry that never expires) is refused.
      if (!(expiresAt > t)) return;
      const key = keyOf(token);
      map.delete(key);
      map.set(key, { payload: structuredClone(payload), expiresAt });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
