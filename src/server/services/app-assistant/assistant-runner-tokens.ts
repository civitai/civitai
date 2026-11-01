import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

/**
 * The credentials civitai signs for App Assistant's server runner (`apps/assistant-runner`), both
 * ES256 JWTs from `ASSISTANT_RUNNER_SIGNING_KEY`. The runner holds only the public half, so it can
 * verify them and forge neither. Each kind has its own `aud` and `typ`, so one is never accepted as
 * the other. The runner's `src/tokens.ts` reads exactly these values.
 *
 * - A viewer token says who a run-API request acts for, for five minutes.
 * - A run grant lets the runner mint tokens for the viewer while it is live. The runner trades it,
 *   with its own secret, for five-minute, user-wide App Assistant tokens at
 *   `/api/internal/app-assistant/runner-token`. The conversation and idempotency key it names
 *   (`cid`, `key`) are checked by the runner at start and patch; the mint does not read them.
 * - A preview grant is a run grant with `use: 'preview'`, for `PREVIEW_GRANT_TTL_SECONDS`: the page
 *   sends one with its Restart preview, which opens the app's live preview with no reply. The runner
 *   takes it for that one request and nothing else, and no other grant there.
 */
export const ASSISTANT_RUNNER_ISSUER = 'civitai';
export const RUNNER_VIEWER_AUDIENCE = 'assistant-runner:viewer';
export const RUNNER_VIEWER_TYP = 'assistant-viewer+jwt';
export const RUN_GRANT_AUDIENCE = 'assistant-runner:run-grant';
export const RUN_GRANT_TYP = 'assistant-run-grant+jwt';
export const RUNNER_VIEWER_TTL_SECONDS = 5 * 60;
/**
 * A preview grant's life: one Restart preview, start to finish, including its last call to civitai.
 * The runner reads the grant on every one of its calls here (its token mints, the tunnel's start,
 * and the stop that closes a tunnel the sandbox could not connect to), so a grant that runs out
 * mid-restart leaves a tunnel open that nothing connects to. The runner's restart, measured from
 * the click (apps/assistant-runner `preview-restart.ts`):
 *   - up to 2 min before the tunnel's start: up to 60 s waiting for an app the page just started
 *     (`RESTART_WAIT_MS`), then a dev server it may start (`DEV_SERVER_WAIT_MS`, 20 s, plus one
 *     probe's 10 s) and a handful of short sandbox calls. The runner does not start a tunnel once
 *     less than the next budget is left (`TUNNEL_START_BUDGET_MS`), so this part cannot eat it;
 *   - then up to 290 s: the start (200 s, the runner's own timeout, above this side's
 *     `RUNNER_DEV_TUNNEL_START_DEADLINE_MS`), a fresh sandbox token (15 s), the sandbox's connect
 *     (60 s), and the stop when it did not connect (15 s).
 * 120 + 290 = 410 s, so 7 minutes. Verified with `CLOCK_SKEW_SECONDS` of tolerance, which is for
 * clocks, not part of this budget.
 */
export const PREVIEW_GRANT_TTL_SECONDS = 7 * 60;
const ALGORITHM = 'ES256';
const CLOCK_SKEW_SECONDS = 30;

let cached:
  | { pem: string; pair: { privateKey: KeyObject; publicKey: KeyObject } | null }
  | undefined;

/**
 * The signing key pair, or `null` when none is configured or the configured one is unusable. Read
 * per call, so a changed env applies; parsed once per value, and an unusable value is logged once
 * (never its contents) and answered as no key (503) from then on.
 */
function keys(): { privateKey: KeyObject; publicKey: KeyObject } | null {
  const pem = env.ASSISTANT_RUNNER_SIGNING_KEY?.trim().replace(/\\n/g, '\n');
  if (!pem) return null;
  if (cached?.pem !== pem) cached = { pem, pair: parse(pem) };
  return cached.pair;
}

function parse(pem: string): { privateKey: KeyObject; publicKey: KeyObject } | null {
  let reason: string;
  try {
    const privateKey = createPrivateKey(pem);
    // ES256 signs with P-256 only: any other key would parse here and fail at the first signature.
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (privateKey.asymmetricKeyType === 'ec' && curve === 'prime256v1')
      return { privateKey, publicKey: createPublicKey(privateKey) };
    reason = `a ${privateKey.asymmetricKeyType ?? 'unknown'} key${
      curve ? ` on ${curve}` : ''
    }, not EC P-256`;
  } catch {
    reason = 'not a private key in PEM';
  }
  logToAxiom({
    type: 'app-assistant.runner-signing-key.unusable',
    message: `ASSISTANT_RUNNER_SIGNING_KEY is unusable (${reason}); the runner endpoints answer 503`,
  }).catch(() => undefined);
  return null;
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
  /**
   * The viewer may start read-only subagents (`appAssistantSubagents`), as the page decides for the
   * browser runner. Signed into the grant (`subagents: true`), so the runner decides it from civitai's
   * word, never from the page's.
   */
  subagents?: boolean;
  /**
   * A preview grant (claim `use: 'preview'`), for `PREVIEW_GRANT_TTL_SECONDS` and never with
   * `subagents`: the runner takes it only for a Restart preview.
   */
  use?: 'preview';
}

/**
 * A run grant for one start, valid for `ASSISTANT_RUNNER_GRANT_TTL_SECONDS`; or, with
 * `use: 'preview'`, a preview grant for one Restart preview, valid for `PREVIEW_GRANT_TTL_SECONDS`.
 */
export function signRunGrant({
  userId,
  conversationId,
  idempotencyKey,
  subagents,
  use,
}: RunGrantFields): Promise<SignedRunnerToken> {
  const preview = use === 'preview';
  return sign(
    {
      cid: conversationId,
      key: idempotencyKey,
      ...(preview ? { use: 'preview' } : subagents ? { subagents: true } : {}),
    },
    {
      audience: RUN_GRANT_AUDIENCE,
      typ: RUN_GRANT_TYP,
      subject: String(userId),
      ttlSeconds: preview ? PREVIEW_GRANT_TTL_SECONDS : env.ASSISTANT_RUNNER_GRANT_TTL_SECONDS,
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
      subagents: payload.subagents === true,
      ...(payload.use === 'preview' ? { use: 'preview' as const } : {}),
      grantId: payload.jti,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}
