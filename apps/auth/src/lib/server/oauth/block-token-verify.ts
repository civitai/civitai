import { createHash, createPublicKey, type KeyObject } from 'crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';

// Verification of an App Block token (the RS256 JWT the site signs for a block at runtime) on the hub, for
// the block token exchange (block-exchange.ts). It follows the site's `verifyBlockToken`
// (src/server/middleware/block-scope.middleware.ts) for every check that decides whether the token is one the
// site issued and still honours: the kid'd key, RS256, `typ: JWT`, issuer, audience, expiry with 30 s skew,
// the claim shapes, and the 15-minute age cap. It is NARROWER than the site's in one direction only: it
// refuses every token the exchange should never turn into a registry token (anonymous, dev, review
// run-for-real, private run), so a looser site rule never widens what the hub mints.
//
// The constants below are the site's (`block-token.service.ts`, `block-token-subject.ts`). The hub cannot
// import the site's modules, so `block-exchange.test.ts` reads those files and fails if either side moves.

/** The site's `BLOCK_TOKEN_ISSUER`. */
export const BLOCK_TOKEN_ISSUER = 'civitai';
/** The site's `BLOCK_TOKEN_AUDIENCE`. */
export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';
/** The site's `USER_SUB_RE`: a signed-in viewer. `anon` never matches. */
export const BLOCK_USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;
/** The site's age cap for every non-dev block token, and its clock tolerance. */
const MAX_AGE_SECONDS = 15 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;

/** The claims of a verified block token that the exchange reads. */
export interface VerifiedBlockToken {
  userId: number;
  /** OauthClient.id of the block's app. */
  appId: string;
  /** AppBlock.id. */
  appBlockId: string;
  blockInstanceId: string;
  jti: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export type BlockTokenRefusal =
  | 'not configured'
  | 'malformed'
  | 'unknown key'
  | 'signature or claims'
  | 'claim shape'
  | 'anonymous'
  | 'dev token'
  | 'review token'
  | 'private run'
  | 'too old';

// The site's kid: sha256 of the key's modulus, first 32 hex characters (`computeKeyId`).
function keyId(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { n?: string };
  return createHash('sha256')
    .update(jwk.n ?? '')
    .digest('hex')
    .slice(0, 32);
}

let cached: { raw: string; keys: Map<string, KeyObject> } | undefined;

/**
 * The site's block-token public keys by kid, from BLOCK_TOKEN_PUBLIC_KEY and BLOCK_TOKEN_PUBLIC_KEY_NEXT (the
 * same PEMs the site verifies with). A PEM that does not parse is skipped; none set is an empty map.
 */
function verificationKeys(): Map<string, KeyObject> {
  const pems = [env.BLOCK_TOKEN_PUBLIC_KEY, env.BLOCK_TOKEN_PUBLIC_KEY_NEXT].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== ''
  );
  const raw = pems.join('\n--\n');
  if (cached && cached.raw === raw) return cached.keys;
  const keys = new Map<string, KeyObject>();
  for (const pem of pems) {
    try {
      const key = createPublicKey(pem);
      keys.set(keyId(key), key);
    } catch {
      // skipped: a bad PEM verifies nothing
    }
  }
  cached = { raw, keys };
  return keys;
}

/** The verified token, or why it is refused. Never throws. */
export async function verifyBlockTokenForExchange(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; token: VerifiedBlockToken } | { ok: false; reason: BlockTokenRefusal }> {
  const keys = verificationKeys();
  if (keys.size === 0) return { ok: false, reason: 'not configured' };

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'RS256' || header.typ !== 'JWT') return { ok: false, reason: 'malformed' };
  const key = typeof header.kid === 'string' ? keys.get(header.kid) : undefined;
  if (!key) return { ok: false, reason: 'unknown key' };

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: BLOCK_TOKEN_ISSUER,
      audience: BLOCK_TOKEN_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
    }));
  } catch {
    return { ok: false, reason: 'signature or claims' };
  }

  const { sub, appId, appBlockId, blockInstanceId, jti, scopes, iat, exp, aud } = payload;
  if (
    typeof sub !== 'string' ||
    typeof appId !== 'string' ||
    !appId ||
    typeof appBlockId !== 'string' ||
    typeof blockInstanceId !== 'string' ||
    typeof jti !== 'string' ||
    !jti ||
    typeof aud !== 'string' ||
    !Array.isArray(scopes) ||
    !scopes.every((s) => typeof s === 'string') ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return { ok: false, reason: 'claim shape' };
  }
  if (!BLOCK_USER_SUB_RE.test(sub)) return { ok: false, reason: 'anonymous' };
  // Each marker refused when present at all, whatever its value: a non-boolean is a shape the site refuses
  // too, and `true` is a token class this exchange never serves.
  if (payload.dev !== undefined && payload.dev !== false) return { ok: false, reason: 'dev token' };
  if (payload.reviewRunForReal !== undefined && payload.reviewRunForReal !== false) {
    return { ok: false, reason: 'review token' };
  }
  if (
    (payload.privateRun !== undefined && payload.privateRun !== false) ||
    payload.privateRunAudience !== undefined
  ) {
    return { ok: false, reason: 'private run' };
  }
  if (nowSeconds - iat > MAX_AGE_SECONDS + CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'too old' };
  }
  return {
    ok: true,
    token: {
      userId: Number(sub.slice('user:'.length)),
      appId,
      appBlockId,
      blockInstanceId,
      jti,
      scopes: scopes as string[],
      iat,
      exp,
    },
  };
}
