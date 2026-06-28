import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { env } from '~/env/server';
import { redis, REDIS_KEYS } from '~/server/redis/client';

// L7 (audit-10): shared issuer/audience constants exported for the
// middleware so a typo in one place can't desynchronize sign-vs-verify.
export const BLOCK_TOKEN_ISSUER = 'civitai';
export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';

const TOKEN_LIFETIME_SECONDS = 900; // 15 minutes — default
const SETTINGS_TOKEN_LIFETIME_SECONDS = 300; // 5 minutes for block:settings:*
// Exported so the verifier (block-scope.middleware.ts) caps the dev max-age off
// the SAME constant the signer uses — if these desynced, dev tokens between the
// two values would silently 401 (fail-closed but confusing).
export const DEV_TOKEN_LIFETIME_SECONDS = 4 * 60 * 60; // 4h — dev:live pasted tokens (self-bound, budget-capped, mod-only)
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 60;

function isSettingsScope(s: string): boolean {
  return s === 'block:settings:read' || s === 'block:settings:write';
}

// L1 (audit-10): memoize both success AND parse-failure outcomes. Otherwise
// every issuance against a malformed PEM re-parses + re-throws on every
// request. The Error sentinel sticks until process restart; ops fixes the
// env, redeploys. Same shape on loadPublicKey / loadNextPublicKey.
type KeyOutcome = { ok: true; key: KeyObject } | { ok: false; error: Error };
let cachedPrivateKey: KeyOutcome | null = null;
let cachedPublicKey: KeyOutcome | null = null;
let cachedNextPublicKey: KeyOutcome | null = null;

function resolveKey(
  cache: KeyOutcome | null,
  setCache: (next: KeyOutcome) => void,
  pem: string | undefined,
  unset: string,
  loader: (pem: string) => KeyObject
): KeyObject {
  if (cache?.ok) return cache.key;
  if (cache && !cache.ok) throw cache.error;
  if (!pem) {
    const e = new Error(unset);
    setCache({ ok: false, error: e });
    throw e;
  }
  try {
    const key = loader(pem);
    setCache({ ok: true, key });
    return key;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    setCache({ ok: false, error: e });
    throw e;
  }
}

function loadPrivateKey(): KeyObject {
  return resolveKey(
    cachedPrivateKey,
    (next) => {
      cachedPrivateKey = next;
    },
    env.BLOCK_TOKEN_PRIVATE_KEY,
    'BLOCK_TOKEN_PRIVATE_KEY is not configured',
    createPrivateKey
  );
}

function loadPublicKey(): KeyObject {
  return resolveKey(
    cachedPublicKey,
    (next) => {
      cachedPublicKey = next;
    },
    env.BLOCK_TOKEN_PUBLIC_KEY,
    'BLOCK_TOKEN_PUBLIC_KEY is not configured',
    createPublicKey
  );
}

/** Optional second public key served during rotation; null when not rotating. */
function loadNextPublicKey(): KeyObject | null {
  if (cachedNextPublicKey?.ok) return cachedNextPublicKey.key;
  if (cachedNextPublicKey && !cachedNextPublicKey.ok) return null;
  const pem = env.BLOCK_TOKEN_PUBLIC_KEY_NEXT;
  if (!pem) {
    // Distinguishable from a parse failure — store as a "no rotation" marker
    // by leaving the cache null; we'll re-check on next call (cheap).
    return null;
  }
  try {
    const key = createPublicKey(pem);
    cachedNextPublicKey = { ok: true, key };
    return key;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    cachedNextPublicKey = { ok: false, error: e };
    return null;
  }
}

/** Exposed so the middleware can try both keys during rotation. */
export function getBlockTokenVerificationKeys(): KeyObject[] {
  const keys: KeyObject[] = [];
  try {
    keys.push(loadPublicKey());
  } catch {
    // signing not configured → nothing to verify against; let the caller decide.
  }
  const next = loadNextPublicKey();
  if (next) keys.push(next);
  return keys;
}

/**
 * Map of kid → public key for kid-based selection during rotation.
 * Audit M-3: the verifier was looping both keys instead of selecting by
 * the header's kid. With this, the middleware reads the JWT header, looks
 * up the exact key, and verifies once. Falls back to all-keys if the
 * header carries no kid (e.g. tokens minted before kid was added).
 *
 * KEY-ROTATION OVERLAP must be >= the MAX token lifetime (now 4h for dev:live
 * tokens — DEV_TOKEN_LIFETIME_SECONDS — not 15min). Keep the retiring public key
 * in BLOCK_TOKEN_PUBLIC_KEY / BLOCK_TOKEN_PUBLIC_KEY_NEXT for >= 4h after the
 * last token signed with it, or in-flight dev tokens 401 across rotation.
 */
export function getBlockTokenVerificationKeysByKid(): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  try {
    const k = loadPublicKey();
    out.set(computeKeyId(k), k);
  } catch {
    // ignore — getBlockTokenVerificationKeys handles the unconfigured case
  }
  const next = loadNextPublicKey();
  if (next) out.set(computeKeyId(next), next);
  return out;
}

export interface SignBlockTokenInput {
  userId: number | null; // null → anonymous viewer
  blockId: string;
  appId: string;
  /**
   * AppBlock.id (the `apb_<ulid>` row id), NOT the OauthClient.id in `appId`.
   * Stamped into the JWT so block-scope.middleware.ts can write
   * BlockScopeInvocation rows without an extra DB lookup per request.
   */
  appBlockId: string;
  blockInstanceId: string;
  scopes: string[];
  ctx: Record<string, unknown>;
  buzzBudget?: number;
  /**
   * The color domain the token was minted on (`green` | `blue` | `red`), or
   * null when the request host didn't resolve to a known color. Advisory /
   * audit field; the AUTHORITATIVE maturity boundary is `maxBrowsingLevel`.
   */
  domain?: string | null;
  /**
   * AUTHORITATIVE maturity ceiling for this token (a bitwise browsing-level
   * flag from `domainBrowsingCeiling`). The block submit/estimate path derives
   * `allowMatureContent` from THIS value, not from any client body field, so a
   * SFW-domain (green/blue) token can never widen to mature output. A token
   * minted before this feature carries NO claim — consumers MUST fail closed
   * (treat absent as SFW), so omit the claim only for that legacy path.
   */
  maxBrowsingLevel?: number;
  /**
   * DEV-TOKEN marker. Set ONLY by the mod-gated dev-token mint endpoint
   * (`/api/v1/blocks/dev-token`) for the `dev:live` localhost harness. When
   * true:
   *   1. the token's lifetime is DEV_TOKEN_LIFETIME_SECONDS (4h) so a developer
   *      can paste a token once and iterate without re-minting every 15min, and
   *   2. a `dev: true` claim is stamped into the signed payload so the verifier
   *      (block-scope.middleware.ts) can apply the per-token-type max-age cap
   *      (4h for dev tokens, 15min for everything else) instead of a single
   *      global 15min cap.
   *
   * PRECEDENCE: `dev` OVERRIDES the settings-scope 5min branch. Dev page tokens
   * never carry block:settings:* scopes (the dev-token endpoint excludes them
   * via DEV_TOKEN_SCOPE_ALLOWLIST), so this collision can't occur in practice;
   * the precedence is made explicit here only so the lifetime selection is
   * unambiguous. The blast radius of the 4h lifetime is bounded by the
   * endpoint's own caps (mod-only, self-bound `sub`, per-call budget cap,
   * forced SFW). Absent/false → byte-identical to the prior behaviour
   * (900s, or 300s for settings scopes).
   */
  dev?: boolean;
}

export interface SignBlockTokenResult {
  token: string;
  expiresAt: string;
  jti: string;
}

function computeKeyId(publicKey: KeyObject): string {
  // Stable kid = sha256 of the modulus (n). Both old and new keys can be
  // served simultaneously during rotation by ranging over multiple PEMs.
  const jwk = publicKey.export({ format: 'jwk' }) as { n?: string };
  const n = jwk.n ?? '';
  return createHash('sha256').update(n).digest('hex').slice(0, 32);
}

export class BlockTokenService {
  static async sign(input: SignBlockTokenInput): Promise<SignBlockTokenResult> {
    const privateKey = loadPrivateKey();
    const publicKey = loadPublicKey();
    const kid = computeKeyId(publicKey);
    const jti = randomBytes(16).toString('hex');
    const iat = Math.floor(Date.now() / 1000);
    // M-4 + H-2 partial: settings-scope tokens get a shorter lifetime so the
    // already-tight ownership check (caller == installer at issuance) has a
    // smaller replay window if the publisher's account is touched after issue.
    //
    // Audit-9 #3: mixed-scope tokens (e.g. user:read:self + block:settings:read)
    // take the shorter 5-min TTL. This is intentional — the conservative
    // security posture wins over the 3× refresh load. Publishers wanting
    // long-lived read scopes can request a separate token without settings
    // scopes; the issuance endpoint handles that cleanly.
    // Lifetime precedence (most-specific wins):
    //   1. dev tokens (4h)        — explicit dev:live marker, OVERRIDES settings
    //   2. settings-scope (5min)  — tightest replay window for installer scopes
    //   3. default (15min)        — every other token
    // Dev page tokens never carry settings scopes (the mint endpoint excludes
    // block:settings:* via DEV_TOKEN_SCOPE_ALLOWLIST), so the dev/settings
    // branches are mutually exclusive in practice; ordering dev first only makes
    // the precedence unambiguous.
    const lifetime =
      input.dev === true
        ? DEV_TOKEN_LIFETIME_SECONDS
        : input.scopes.some(isSettingsScope)
        ? SETTINGS_TOKEN_LIFETIME_SECONDS
        : TOKEN_LIFETIME_SECONDS;
    const exp = iat + lifetime;
    const sub = input.userId == null ? 'anon' : `user:${input.userId}`;

    const claims: Record<string, unknown> = {
      blockId: input.blockId,
      appId: input.appId,
      appBlockId: input.appBlockId,
      blockInstanceId: input.blockInstanceId,
      ctx: input.ctx,
      scopes: input.scopes,
    };
    if (typeof input.buzzBudget === 'number') {
      claims.buzzBudget = input.buzzBudget;
    }
    // Maturity enforcement claims. `maxBrowsingLevel` is the authoritative
    // server-minted ceiling the block submit/estimate path clamps generation
    // against; `domain` is an advisory audit/UX signal. Both are stamped at
    // mint from the request host so the block's own (untrusted) code can never
    // influence them.
    if (typeof input.maxBrowsingLevel === 'number') {
      claims.maxBrowsingLevel = input.maxBrowsingLevel;
    }
    if (input.domain != null) {
      claims.domain = input.domain;
    }
    // DEV marker — stamped ONLY for dev:live tokens. The verifier reads this
    // (after signature + iss/aud/exp validation) to pick the per-token-type
    // max-age cap (4h for dev, 15min otherwise). Stamped only when explicitly
    // true so a non-dev token never carries the claim (absent → 15min cap).
    if (input.dev === true) {
      claims.dev = true;
    }

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(BLOCK_TOKEN_ISSUER)
      .setAudience(BLOCK_TOKEN_AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(iat)
      // M-3: set NBF to issued-at so verifiers see a consistent floor.
      // Skew tolerance on the verify side absorbs the typical 0–2s drift.
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(privateKey);

    return {
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
      jti,
    };
  }

  /**
   * Issues 60/min per (subject, blockInstanceId).
   *
   * H-3 fix: anon callers key on (ip, blockInstanceId) — without the IP
   * component, a single attacker could rotate blockInstanceId through 1-64
   * char strings and mint a fresh bucket per ID, exhausting the per-IP
   * budget on findUnique 404s as fast as their network allowed.
   *
   * Authenticated users keep (userId, blockInstanceId); the userId is
   * stable per-session so churning instance IDs only hurts the attacker.
   *
   * Returns true if the call is allowed; false if the limit is exceeded.
   */
  static async checkRateLimit(
    userId: number | null,
    blockInstanceId: string,
    clientIp = 'unknown'
  ): Promise<boolean> {
    const subject = userId == null ? `anonip:${clientIp}` : `u${userId}`;
    const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:${subject}:${blockInstanceId}` as const;
    try {
      // Atomically set TTL on first hit so a Redis crash / manual SET can't
      // leave a TTL-less key around (which would make the window permanent).
      // INCR returns 1 on first hit; we issue EX in the same RTT batch by
      // setting NX + EX up front when count===1.
      const count = await redis.incrBy(key as never, 1);
      if (count === 1) {
        await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);
      } else {
        // Defensive: if a previous code path lost the TTL, set it now. NX
        // semantics aren't exposed by the client wrapper, so we read ttl
        // first to avoid extending an active window.
        const ttl = await redis.ttl(key as never);
        if (ttl < 0) await redis.expire(key as never, RATE_LIMIT_WINDOW_SECONDS);
      }
      return count <= RATE_LIMIT_MAX;
    } catch {
      // Fail open — never block legitimate traffic on a Redis incident.
      return true;
    }
  }

  static getJwks(): {
    keys: Array<{ kty: string; use: string; alg: string; kid: string; n: string; e: string }>;
  } {
    const keys: Array<{ kty: string; use: string; alg: string; kid: string; n: string; e: string }> = [];
    const current = loadPublicKey();
    const next = loadNextPublicKey();
    for (const k of next ? [current, next] : [current]) {
      const jwk = k.export({ format: 'jwk' }) as { kty?: string; n?: string; e?: string };
      keys.push({
        kty: jwk.kty ?? 'RSA',
        use: 'sig',
        alg: 'RS256',
        kid: computeKeyId(k),
        n: jwk.n ?? '',
        e: jwk.e ?? '',
      });
    }
    return { keys };
  }
}
