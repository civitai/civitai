import { createHash, createPublicKey, type KeyObject } from 'crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { logToAxiom } from '$lib/server/axiom';

// Verification of an App Block token (the RS256 JWT the site signs for a block at runtime) on the hub, for
// the block token exchange (block-exchange.ts). It follows the site's `verifyBlockToken`
// (src/server/middleware/block-scope.middleware.ts) for every check that decides whether the token is one the
// site issued and still honours: the kid'd key, RS256, `typ: JWT`, issuer, audience, expiry with 30 s skew,
// the claim shapes, and the 15-minute age cap. It is NARROWER than the site's in one direction only: it
// refuses every token the exchange should never turn into a registry token (anonymous, dev, review
// run-for-real, private run), so a looser site rule never widens what the hub mints.
//
// The constants below are the site's (`block-token.service.ts`, `block-token-subject.ts`,
// `block-scope.middleware.ts`). The hub cannot import the site's modules, so `block-exchange.test.ts` pins
// the issuer, audience, subject pattern, kid derivation, age cap and clock tolerance on both sides, and
// fails if either side's value moves.

/** The site's `BLOCK_TOKEN_ISSUER`. */
export const BLOCK_TOKEN_ISSUER = 'civitai';
/** The site's `BLOCK_TOKEN_AUDIENCE`. */
export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';
/** The site's `USER_SUB_RE`: a signed-in viewer. `anon` never matches. */
export const BLOCK_USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;
/** The site's age cap for every non-dev block token, and its clock tolerance. */
export const MAX_AGE_SECONDS = 15 * 60;
export const CLOCK_TOLERANCE_SECONDS = 30;

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
  /**
   * The token's maturity ceiling (the site's `maxBrowsingLevel` claim: a browsing-level bit flag set from
   * the host it was minted on), or null when absent or not a non-negative integer, which the site reads
   * as SFW.
   */
  maxBrowsingLevel: number | null;
  /**
   * The viewer's own browsing level (the site's `viewerBrowsingLevel` claim), or null when absent, which
   * the site reads as PG (`resolveViewerBrowsingLevel`). A present value that is not a non-negative integer
   * is a shape the site refuses, and so is the token here (`claim shape`).
   */
  viewerBrowsingLevel: number | null;
}

export type BlockTokenRefusal =
  | 'not configured'
  | 'misconfigured'
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

type KeySet = { keys: Map<string, KeyObject> } | { error: string };

let cached: { raw: string; result: KeySet } | undefined;

const KEY_ENV = ['BLOCK_TOKEN_PUBLIC_KEY', 'BLOCK_TOKEN_PUBLIC_KEY_NEXT'] as const;

/** The key a configured PEM holds, or why it cannot verify block tokens. Never echoes the value. */
function publicKeyProblem(pem: string): string | { key: KeyObject } {
  // A private key parses as a public one (node derives it), so it is refused by its armour first: a
  // private key in this variable means the signing key was pasted where only the public half belongs.
  if (/PRIVATE KEY/.test(pem)) return 'is a private key';
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    return 'does not parse as a public key';
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') return 'is not an RSA public key';
  return { key };
}

/**
 * The site's block-token public keys by kid, from BLOCK_TOKEN_PUBLIC_KEY and BLOCK_TOKEN_PUBLIC_KEY_NEXT (the
 * same PEMs the site verifies with). FAIL CLOSED: one configured value that is a private key or not an RSA
 * public key makes the whole set an error, logged once per distinct configuration, and every token is
 * refused until it is fixed. With neither variable set the map is empty, and the exchange refuses every
 * token as not configured.
 */
function verificationKeys(): KeySet {
  const configured = KEY_ENV.map((name) => [name, env[name]] as const).filter(
    (e): e is readonly [(typeof KEY_ENV)[number], string] =>
      typeof e[1] === 'string' && e[1].trim() !== ''
  );
  const raw = configured.map(([name, pem]) => `${name}=${pem}`).join('\n--\n');
  if (cached && cached.raw === raw) return cached.result;
  const keys = new Map<string, KeyObject>();
  let result: KeySet = { keys };
  for (const [name, pem] of configured) {
    const parsed = publicKeyProblem(pem);
    if (typeof parsed === 'string') {
      result = { error: `${name} ${parsed}` };
      void logToAxiom({
        type: 'error',
        name: 'block-token-public-key-invalid',
        message: result.error,
      });
      break;
    }
    keys.set(keyId(parsed.key), parsed.key);
  }
  cached = { raw, result };
  return result;
}

const isNonNegativeInteger = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The verified token, or why it is refused. Never throws. */
export async function verifyBlockTokenForExchange(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; token: VerifiedBlockToken } | { ok: false; reason: BlockTokenRefusal }> {
  const keySet = verificationKeys();
  if ('error' in keySet) return { ok: false, reason: 'misconfigured' };
  const { keys } = keySet;
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

  const {
    sub,
    appId,
    appBlockId,
    blockInstanceId,
    jti,
    scopes,
    iat,
    exp,
    aud,
    maxBrowsingLevel,
    viewerBrowsingLevel,
  } = payload;
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
    typeof exp !== 'number' ||
    // The site's shape guard (`verifyBlockToken`): optional, but when present a non-negative integer.
    (viewerBrowsingLevel !== undefined && !isNonNegativeInteger(viewerBrowsingLevel))
  ) {
    return { ok: false, reason: 'claim shape' };
  }
  if (!BLOCK_USER_SUB_RE.test(sub)) return { ok: false, reason: 'anonymous' };
  // Each marker refused unless absent or exactly `false`: a non-boolean is a shape the site refuses too, and
  // `true` is a token class this exchange never serves.
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
      maxBrowsingLevel: isNonNegativeInteger(maxBrowsingLevel) ? maxBrowsingLevel : null,
      viewerBrowsingLevel: isNonNegativeInteger(viewerBrowsingLevel) ? viewerBrowsingLevel : null,
    },
  };
}
