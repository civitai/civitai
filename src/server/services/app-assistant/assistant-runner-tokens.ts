import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '~/env/server';

/**
 * The credentials civitai signs for App Assistant's server runner (`apps/assistant-runner`), both
 * ES256 JWTs from `ASSISTANT_RUNNER_SIGNING_KEY`. The runner holds only the public half, so it can
 * verify them and forge neither. Each kind has its own `aud` and `typ`, so one is never accepted as
 * the other. The runner's `src/tokens.ts` reads exactly these values.
 *
 * - A viewer token says who a run-API request acts for, for five minutes.
 * - A run grant lets the runner act for the viewer in one conversation, for one start (its
 *   idempotency key), for one run's life. The runner trades it, with its own secret, for
 *   five-minute tokens at `/api/internal/app-assistant/runner-token`.
 */
export const ASSISTANT_RUNNER_ISSUER = 'civitai';
export const RUNNER_VIEWER_AUDIENCE = 'assistant-runner:viewer';
export const RUNNER_VIEWER_TYP = 'assistant-viewer+jwt';
export const RUN_GRANT_AUDIENCE = 'assistant-runner:run-grant';
export const RUN_GRANT_TYP = 'assistant-run-grant+jwt';
export const RUNNER_VIEWER_TTL_SECONDS = 5 * 60;
const ALGORITHM = 'ES256';
const CLOCK_SKEW_SECONDS = 30;

let cached: { pem: string; privateKey: KeyObject; publicKey: KeyObject } | undefined;

/** The signing key pair, or `null` when none is configured. Read per call, so a changed env applies. */
function keys(): { privateKey: KeyObject; publicKey: KeyObject } | null {
  const pem = env.ASSISTANT_RUNNER_SIGNING_KEY?.trim().replace(/\\n/g, '\n');
  if (!pem) return null;
  if (cached?.pem !== pem) {
    try {
      const privateKey = createPrivateKey(pem);
      cached = { pem, privateKey, publicKey: createPublicKey(privateKey) };
    } catch {
      // A key that does not parse is no key: the endpoints answer 503, as when it is unset.
      return null;
    }
  }
  return cached;
}

export function isAssistantRunnerConfigured(): boolean {
  return keys() !== null;
}

export interface SignedRunnerToken {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

async function sign(
  claims: Record<string, unknown>,
  {
    audience,
    typ,
    subject,
    ttlSeconds,
  }: { audience: string; typ: string; subject: string; ttlSeconds: number }
): Promise<SignedRunnerToken> {
  const pair = keys();
  if (!pair) throw new Error('ASSISTANT_RUNNER_SIGNING_KEY is not configured');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM, typ })
    .setIssuer(ASSISTANT_RUNNER_ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(pair.privateKey);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** A viewer token for `userId`: who a request to the runner acts for. */
export function signRunnerViewerToken(userId: number): Promise<SignedRunnerToken> {
  return sign(
    {},
    {
      audience: RUNNER_VIEWER_AUDIENCE,
      typ: RUNNER_VIEWER_TYP,
      subject: String(userId),
      ttlSeconds: RUNNER_VIEWER_TTL_SECONDS,
    }
  );
}

export interface RunGrantFields {
  userId: number;
  conversationId: string;
  idempotencyKey: string;
}

/** A run grant for one start, valid for `ASSISTANT_RUNNER_GRANT_TTL_SECONDS`. */
export function signRunGrant({
  userId,
  conversationId,
  idempotencyKey,
}: RunGrantFields): Promise<SignedRunnerToken> {
  return sign(
    { cid: conversationId, key: idempotencyKey },
    {
      audience: RUN_GRANT_AUDIENCE,
      typ: RUN_GRANT_TYP,
      subject: String(userId),
      ttlSeconds: env.ASSISTANT_RUNNER_GRANT_TTL_SECONDS,
    }
  );
}

export interface VerifiedRunGrant extends RunGrantFields {
  /** The grant's own id (`jti`). */
  grantId: string;
  expiresAt: Date;
}

/**
 * The run grant, when it is one civitai signed, of the grant kind, and not expired; otherwise
 * `null`. A viewer token is refused here, as a grant is refused where a viewer token is expected.
 */
export async function verifyRunGrant(token: string): Promise<VerifiedRunGrant | null> {
  const pair = keys();
  if (!pair || !token) return null;
  try {
    const { payload } = await jwtVerify(token, pair.publicKey, {
      algorithms: [ALGORITHM],
      issuer: ASSISTANT_RUNNER_ISSUER,
      audience: RUN_GRANT_AUDIENCE,
      typ: RUN_GRANT_TYP,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['sub', 'exp', 'jti'],
    });
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    if (typeof payload.cid !== 'string' || !payload.cid) return null;
    if (typeof payload.key !== 'string' || !payload.key) return null;
    if (typeof payload.jti !== 'string' || !payload.jti || !payload.exp) return null;
    return {
      userId,
      conversationId: payload.cid,
      idempotencyKey: payload.key,
      grantId: payload.jti,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}
