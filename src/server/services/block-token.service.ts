import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { env } from '~/env/server';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { BLOCK_TOKEN_LIFETIMES_SECONDS } from '~/server/services/block-token-lifetimes';
import { ANON_SUBJECT, subjectForUserId } from '~/server/services/block-token-subject';

// L7 (audit-10): shared issuer/audience constants exported for the
// middleware so a typo in one place can't desynchronize sign-vs-verify.
export const BLOCK_TOKEN_ISSUER = 'civitai';
export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';

// Re-exported so the verifier (block-scope.middleware.ts) caps the dev max-age
// off the SAME constant the signer uses — if these desynced, dev tokens between
// the two values would silently 401 (fail-closed but confusing).
export const DEV_TOKEN_LIFETIME_SECONDS = BLOCK_TOKEN_LIFETIMES_SECONDS.dev;
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
  /**
   * MOD REVIEW SANDBOX "run for real" marker (#2831). Set ONLY by
   * `mintReviewBlockToken({ runForReal: true })` — a moderator's explicit,
   * consent-gated opt-in to run an UNAPPROVED review app FOR REAL against their
   * OWN account. When true a `reviewRunForReal: true` claim is stamped so the
   * runtime spend paths (submitWorkflow / customComfy) enforce the TIGHT
   * per-(mod, publishRequestId) AGGREGATE Buzz ceiling
   * (`REVIEW_RUN_FOR_REAL_BUZZ_CAP`) rather than the ordinary per-user daily cap.
   * Only trustworthy because the RS256 signature is verified before the claim is
   * read (a forged `reviewRunForReal:true` can't pass the signature gate). Does
   * NOT change the token lifetime (run-for-real tokens are also `dev:true`).
   * Absent/false → byte-identical to a normal token (no claim stamped).
   */
  reviewRunForReal?: boolean;
  /**
   * PRIVATE-RUN marker. Set ONLY by the (not-yet-built) private-run mint branch,
   * which serves a DELISTED / SUSPENDED app's already-deployed bundle to its
   * owner, an accepted listing collaborator, or a moderator — never publicly.
   *
   * 🔴 IT IS A MONEY-SAFETY CLAIM, NOT A UX ONE, AND IT IS THE ONLY INPUT THE TWO
   * ARMS HAVE. A private run is a diagnostic or a takedown review, not a use of
   * the app, so neither money rail may treat it as one:
   *   1. `recordSpendAttribution` VOIDS the `block_spend_attribution` row it would
   *      otherwise write as `tracked`, so a review generation cannot inflate a
   *      suspended app's owner-visible run count or Buzz total.
   *   2. `resolveBlockAuthorFeePayee` REFUSES, so the per-generation author fee is
   *      never quoted, reserved or debited. Without this the reviewer is debited
   *      and the suspended publisher is credited the same Buzz — the platform takes
   *      no cut, so it is a straight transfer from the moderator reviewing a
   *      takedown to the author who was taken down.
   *
   * Both arms read the claim only AFTER the RS256 signature is verified, so a
   * forged `privateRun: true` cannot pass the gate. Stamped only when explicitly
   * true, so a normal token never carries it and `undefined` is byte-identical to
   * the pre-feature behaviour.
   *
   * 🔴 THIS IS NOT `dev`, AND MUST NEVER BE SET ALONGSIDE IT. `claims.dev === true`
   * SKIPS the per-app velocity reservation in `reserveBlockBuzzSpendForClaims`, which
   * would hand a moderator an uncapped per-app spend surface on an app the platform has
   * taken down. The combination is refused at this signer (it throws) and again at the
   * verifier.
   *
   * ⚠️ CORRECTED WHEN THE MINT LANDED — THIS USED TO SAY `privateRun` "changes no
   * lifetime and no cap selection", AND THE CAP HALF IS NO LONGER TRUE. It was true
   * while the claim had no producer. `reserveBlockBuzzSpendForClaims` now has a
   * `claims.privateRun === true` arm that selects a per-(viewer, appBlockId) cumulative
   * ceiling (`PRIVATE_RUN_BUZZ_CAP`) in place of the ordinary per-user daily cap —
   * strictly TIGHTER per app, and deliberately placed ABOVE the `claims.dev` early
   * return so it can never be skipped. Without an arm of its own a private run would
   * fall through to the 50k/day platform key, i.e. 20× looser and shared with the
   * viewer's legitimate app usage.
   *
   * ✅ THE LIFETIME HALF STILL HOLDS AND IS STILL PINNED: `privateRun` appears nowhere
   * in the lifetime selector, so a private-run token takes the ordinary 900s default
   * rather than the `dev` 4h. That is the half worth keeping, because a long-lived token
   * on a taken-down app is the thing a delist is supposed to stop.
   */
  privateRun?: boolean;
  /**
   * WHICH audience a private run was admitted as. Meaningful ONLY alongside
   * `privateRun: true`, and refused without it (see the signer).
   *
   * 🔴 IT IS BRANCHED ON IN TWO PLACES, WHICH IS WHY IT IS SIGNED AT ALL. PR 1
   * deliberately did NOT sign this field, because at that point it had no producer and
   * no consumer, and a signed field nothing branches on is the field-exists-but-nothing-
   * reads-it shape this feature's own seam guard forbids. It earns its place here:
   *   1. `resolveAppBlockApprovalVerdict` keys the private-run exemption from the
   *      approved-status decision on the PAIR — `privateRun === true` AND a recognised
   *      audience — mirroring how the review-sandbox exemption is keyed on the
   *      `dev && reviewRunForReal` pair rather than on one boolean. A claim that
   *      exempts a token from a status gate must not be one flipped bit wide.
   *   2. The runtime editor read-only belt refuses `'editor'` on the spend path, as
   *      defence-in-depth behind the mint-time scope strip. Two layers, because the
   *      mint-time strip is a decision taken once at issue time while this one is
   *      re-taken per submit.
   *
   * 🔴 IT IS NOT ON ANY MONEY ROW, DELIBERATELY. The `block_spend_attribution` void
   * arm keys on `privateRun` alone and is audience-BLIND, so it holds for whichever
   * audiences the clamp ends up admitting. The audience rides the mint's audit line
   * instead, which is where "how many private runs, by whom, on what" is answered.
   *
   * Validated as a closed set by the verifier (`isPrivateRunAudience`), so a
   * signature-valid token carrying a garbage audience is rejected outright rather than
   * silently failing an equality test against `'editor'` and being treated as an
   * owner.
   */
  privateRunAudience?: 'owner' | 'editor' | 'moderator';
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
        ? BLOCK_TOKEN_LIFETIMES_SECONDS.dev
        : input.scopes.some(isSettingsScope)
        ? BLOCK_TOKEN_LIFETIMES_SECONDS.settings
        : BLOCK_TOKEN_LIFETIMES_SECONDS.default;
    const exp = iat + lifetime;
    // Built through the shared encoder rather than open-coded. This template used to be
    // written here AND in `block-revocation.service` (whose docblock claimed to be "THE
    // ONE PLACE this format is written on the WRITE side" while this line existed), and
    // every consumer pinned its own copy with its own literal — so nothing in the suite
    // could see them diverge. See `block-token-subject.ts`.
    const sub = input.userId == null ? ANON_SUBJECT : subjectForUserId(input.userId);

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
    // RUN-FOR-REAL marker — stamped ONLY for a mod's consent-gated review
    // run-for-real token. Read (after signature validation) by the runtime spend
    // paths to select the tight per-(mod, publishRequestId) aggregate Buzz cap.
    // Stamped only when explicitly true so a normal token never carries it.
    if (input.reviewRunForReal === true) {
      claims.reviewRunForReal = true;
    }
    // 🔴 THE `privateRun` + `dev` COMBINATION IS REFUSED AT THE SIGNER, NOT WARNED
    // ABOUT IN A COMMENT. The input docblock declares this a MUST-NEVER because
    // `claims.dev === true` SKIPS the per-app velocity reservation in
    // `reserveBlockBuzzSpendForClaims` — so a `dev` private-run token would hand a
    // non-owner an UNCAPPED per-app spend surface on an app the platform has taken
    // down. A review lane pointed out that the rule existed only as prose, and prose
    // in a docblock cannot stop a mint that reaches for `dev: true` to get past a
    // status gate. `resolveAppBlockApprovalVerdict` records the same hazard from the
    // other side: the run-for-real exemption had to be keyed on the dev+flag PAIR.
    //
    // Throwing is safe to add now precisely because it is UNREACHABLE now — nothing
    // sets `privateRun`, so no existing caller can trip it. It becomes load-bearing
    // the moment the mint exists, which is when it would otherwise be discovered by
    // a cap that silently stopped applying.
    if (input.privateRun === true && input.dev === true) {
      throw new Error(
        'block token: privateRun and dev must not be combined — `dev` skips the per-app ' +
          'spend reservation, which would leave a private run uncapped per app'
      );
    }
    // PRIVATE-RUN marker — stamped ONLY for a private run of a delisted/suspended
    // app. Read (after signature validation) by the two money arms: the spend
    // attribution void and the author-fee refusal. Stamped only when explicitly
    // true so a normal token never carries it.
    if (input.privateRun === true) {
      claims.privateRun = true;
    }
    // 🔴 THE AUDIENCE IS REFUSED WITHOUT THE MARKER, for the same reason the marker is
    // refused alongside `dev`: a lone `privateRunAudience` would be a claim that looks
    // like an authorisation and carries none. `resolveAppBlockApprovalVerdict` keys its
    // status exemption on the PAIR, so a token carrying only the audience would be
    // exempt from nothing while reading, to anyone inspecting it, as a private-run
    // token. Refusing the half-stamped shape at the producer keeps the pair the only
    // representable state.
    if (input.privateRunAudience !== undefined && input.privateRun !== true) {
      throw new Error(
        'block token: privateRunAudience requires privateRun: true — a lone audience ' +
          'claim exempts a token from nothing and misreads as a private-run token'
      );
    }
    // The audience a private run was admitted as. Stamped only alongside the marker;
    // read (after signature validation) by the approval-verdict exemption and the
    // runtime editor read-only belt. Not on any money row — see the input docblock.
    if (input.privateRun === true && input.privateRunAudience !== undefined) {
      claims.privateRunAudience = input.privateRunAudience;
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
    const keys: Array<{
      kty: string;
      use: string;
      alg: string;
      kid: string;
      n: string;
      e: string;
    }> = [];
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
