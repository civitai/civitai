import { createHash } from 'crypto';
import type { JWTPayload, JWSHeaderParameters } from 'jose';

// A per-process cache of ES256 signature verifications, so a token presented on many requests pays for the
// signature maths once. An entry records three things about a token that passed `jwtVerify` (signature,
// issuer, audience): its payload, its protected header, and the exact key object that verified it.
//
// What a cached outcome depends on, and how each part is re-checked on a hit (verify.ts):
//  - the token bytes: the entry is keyed by a digest of the whole token, so it only ever answers for those bytes;
//  - the verifier's issuer/audience config: fixed for the verifier's life;
//  - the clock: `exp` is enforced here on every hit (an entry never outlives exp * 1000);
//  - the key set, which CAN change (rotation, a removed kid, a reload): on every hit verify.ts re-resolves the key
//    for the stored header through the same getter `jwtVerify` uses, and accepts the hit only if that returns the
//    SAME key object that verified the signature. Otherwise the entry is dropped.
// The lineage limits and the revocation read are not cached at all — verify.ts runs them on every call.

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

export interface VerifiedClaimsHit {
  /** A copy — callers may mutate it. */
  payload: JWTPayload;
  protectedHeader: JWSHeaderParameters;
  /** The key object that verified the signature, compared by identity on a hit. */
  signingKey: unknown;
}

interface Entry extends VerifiedClaimsHit {
  /** Epoch ms after which the entry must not be served: min(insert + ttl, exp * 1000). */
  expiresAt: number;
}

export interface VerifiedClaimsCache {
  /** The entry for exactly this token, unexpired, or undefined. */
  get(token: string): VerifiedClaimsHit | undefined;
  /** Record a token that just passed verification. A payload without a usable `exp` is not stored. */
  set(token: string, entry: VerifiedClaimsHit): void;
  delete(token: string): void;
  clear(): void;
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
      return {
        payload: structuredClone(entry.payload),
        protectedHeader: entry.protectedHeader,
        signingKey: entry.signingKey,
      };
    },
    set(token, { payload, protectedHeader, signingKey }) {
      const t = opts.clock();
      // ONE guard for every unusable `exp`: a missing one (undefined → NaN here) and a NaN one both make
      // expiresAt NaN, and `NaN > t` is false. Without it a missing `exp` would leave the TTL as the only bound,
      // and a NaN one would make an entry that never expires. (jose rejects a non-numeric `exp` itself.)
      const expiresAt = Math.min(t + ttlMs, (payload.exp ?? NaN) * 1000);
      if (!(expiresAt > t)) return;
      const key = keyOf(token);
      map.delete(key);
      map.set(key, {
        payload: structuredClone(payload),
        protectedHeader: structuredClone(protectedHeader),
        signingKey,
        expiresAt,
      });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(token) {
      map.delete(keyOf(token));
    },
    clear() {
      map.clear();
    },
  };
}
