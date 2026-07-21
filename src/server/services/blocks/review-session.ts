import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * MOD REVIEW SANDBOX (#2831) — parent-minted, short-TTL, mod-bound access token.
 *
 * The review preview is a CROSS-ORIGIN iframe: `review-<sha16>.civit.ai`
 * embedded inside the civitai.com `/apps/review` page. The civitai session
 * cookie is scoped to civitai.com and is therefore NOT sent to the `*.civit.ai`
 * forwardAuth target — so the old cookie-resolving mod-gate 401s everyone (the
 * documented PRE-FLAG-FLIP blocker).
 *
 * The fix: the civitai.com parent page is ALREADY authenticated and sets the
 * iframe `src`, so it can inject a signed token directly into the URL
 * (`?mr=<token>`). No cross-domain cookie, no redirect bounce. The mod-gate
 * forwardAuth verifies the token on the ENTRY document request.
 *
 * Token design:
 *   - payload `{ m: modUserId, h: host, exp: nowSec + 120 }`
 *   - signed with HMAC-SHA256 over the DOMAIN-SEPARATED string
 *     `review-mr:v1:${m}:${h}:${exp}` (the `review-mr:v1:` prefix prevents this
 *     signature from ever being confused with any other HMAC the app produces
 *     over the same secret).
 *   - secret = `env.NEXTAUTH_SECRET` (present in every civitai-web deployment;
 *     no new secret to provision).
 *   - compact wire form `base64url(json(payload)).base64url(sig)`.
 *   - 120s TTL: the token only needs to survive from mint (the parent's
 *     getReviewStatus poll) → the iframe document load. A fresh URL is minted on
 *     every poll, so the live iframe never goes stale.
 *
 * This module is PURE (crypto + the injected secret) so it is unit-testable
 * without a DB / k8s / session.
 */

/** ENTRY-token TTL in seconds. Intentionally short: mint → iframe document load. */
export const REVIEW_ACCESS_TOKEN_TTL_SECONDS = 120;

/** Domain-separation prefix for the short-TTL ENTRY token (carried as `?mr=`).
 *  So this HMAC can never collide with another the app signs over the same
 *  NEXTAUTH_SECRET. Bump `v1` if the payload shape changes. */
const DOMAIN_PREFIX = 'review-mr:v1';

type ReviewAccessPayload = {
  /** Moderator user id the token is bound to (audit + X-Mod-Id). */
  m: number;
  /** review host the token authorizes (`review-<sha16>.<APPS_DOMAIN>`). */
  h: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
};

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** The domain-separated string for the short-TTL ENTRY (`mr`) token that is
 *  HMAC'd. The `DOMAIN_PREFIX` ensures this HMAC can never collide with another
 *  the app signs over the same NEXTAUTH_SECRET. */
function signingString(p: ReviewAccessPayload): string {
  return `${DOMAIN_PREFIX}:${p.m}:${p.h}:${p.exp}`;
}

function hmac(secret: string, signingStr: string): Buffer {
  return createHmac('sha256', secret).update(signingStr).digest();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export type SignReviewAccessTokenParams = {
  modUserId: number;
  host: string;
  /** Injected for testability; defaults to env.NEXTAUTH_SECRET. */
  secret?: string;
  /** Injected for testability; defaults to REVIEW_ACCESS_TOKEN_TTL_SECONDS. */
  ttlSeconds?: number;
};

/**
 * Mint a compact `base64url(payload).base64url(sig)` review access token bound
 * to (modUserId, host), valid for `ttlSeconds` (default 120s).
 */
export function signReviewAccessToken(params: SignReviewAccessTokenParams): string {
  const secret = params.secret ?? resolveSecret();
  const ttl = params.ttlSeconds ?? REVIEW_ACCESS_TOKEN_TTL_SECONDS;
  const payload: ReviewAccessPayload = {
    m: params.modUserId,
    h: params.host,
    exp: nowSec() + ttl,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sigB64 = base64url(hmac(secret, signingString(payload)));
  return `${payloadB64}.${sigB64}`;
}

export type VerifyReviewAccessTokenResult = {
  ok: boolean;
  modUserId?: number;
};

/**
 * Verify a review access token against the expected host. NEVER throws on
 * malformed input — returns `{ ok:false }`. Checks:
 *   - structurally parseable payload + signature
 *   - constant-time (timingSafeEqual) HMAC match
 *   - not expired (`exp > nowSec`)
 *   - bound host equals `expectedHost`
 */
export function verifyReviewAccessToken(
  token: string | null | undefined,
  expectedHost: string,
  opts?: { secret?: string }
): VerifyReviewAccessTokenResult {
  const fail: VerifyReviewAccessTokenResult = { ok: false };
  if (!token || typeof token !== 'string') return fail;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return fail;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload: ReviewAccessPayload;
  try {
    const parsed = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.m !== 'number' ||
      typeof parsed.h !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return fail;
    }
    payload = parsed as ReviewAccessPayload;
  } catch {
    return fail;
  }

  let secret: string;
  try {
    secret = opts?.secret ?? resolveSecret();
  } catch {
    return fail;
  }

  // Recompute over the SAME domain-separated string from the parsed payload, so a
  // tampered payload (different m/h/exp) yields a different signing string → the
  // constant-time compare below fails.
  const expectedSig = hmac(secret, signingString(payload));
  let providedSig: Buffer;
  try {
    providedSig = base64urlToBuffer(sigB64);
  } catch {
    return fail;
  }
  // timingSafeEqual requires equal-length buffers; a length mismatch is a
  // definitive non-match (and would throw), so guard it explicitly.
  if (providedSig.length !== expectedSig.length) return fail;
  if (!timingSafeEqual(providedSig, expectedSig)) return fail;

  if (payload.exp <= nowSec()) return fail;
  if (payload.h !== expectedHost) return fail;

  return { ok: true, modUserId: payload.m };
}

/** Resolve NEXTAUTH_SECRET lazily so the module stays import-cheap + testable
 *  (callers can inject `secret` directly to avoid env resolution). */
function resolveSecret(): string {
  // Lazy require to avoid pulling the env validator into every importer.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return secret;
}

// ---------------------------------------------------------------------------
// AGENTIC MOD CODE-REVIEW (App Blocks P1) — per-review callback bearer token.
//
// The ephemeral review agent pod posts its report back to the internal
// `agent-report-callback` route. It authenticates with a per-review bearer token
// minted HERE and injected into the pod env (CALLBACK_TOKEN) — deliberately NOT
// the fleet-wide `BLOCK_BUILD_CALLBACK_SECRET` (which must never leave civitai-web
// onto an untrusted agent pod). The token is bound to the `publishRequestId` and
// short-lived, so a leaked token can only touch THAT review's report and only for
// the run window.
//
// Same construction as the `mr` entry token above (domain-separated HMAC over
// NEXTAUTH_SECRET, compact `base64url(payload).base64url(sig)`), but a DISTINCT
// domain prefix so the two signatures can never be confused, and it binds
// `publishRequestId` (not a host + mod id).
// ---------------------------------------------------------------------------

/** Callback-token TTL. Bounds the whole agent run (bundle pull → analysis →
 *  report POST). 30 min is a generous ceiling for a cost-capped single review. */
export const AGENT_CALLBACK_TOKEN_TTL_SECONDS = 30 * 60;

/** Domain-separation prefix for the agent report-callback bearer. Bump `v1` if
 *  the payload shape changes. */
const AGENT_CALLBACK_DOMAIN_PREFIX = 'agent-report:v1';

type AgentCallbackPayload = {
  /** publishRequestId the token authorizes a report write for. */
  p: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
};

/** The domain-separated string HMAC'd for the agent report-callback bearer. */
function agentCallbackSigningString(payload: AgentCallbackPayload): string {
  return `${AGENT_CALLBACK_DOMAIN_PREFIX}:${payload.p}:${payload.exp}`;
}

export type SignAgentCallbackTokenParams = {
  publishRequestId: string;
  /** Injected for testability; defaults to env.NEXTAUTH_SECRET. */
  secret?: string;
  /** Injected for testability; defaults to AGENT_CALLBACK_TOKEN_TTL_SECONDS. */
  ttlSeconds?: number;
};

/**
 * Mint a compact `base64url(payload).base64url(sig)` bearer bound to a
 * publishRequestId, valid for `ttlSeconds` (default 30m). Injected into the
 * review agent pod as CALLBACK_TOKEN.
 */
export function signAgentCallbackToken(params: SignAgentCallbackTokenParams): string {
  const secret = params.secret ?? resolveSecret();
  const ttl = params.ttlSeconds ?? AGENT_CALLBACK_TOKEN_TTL_SECONDS;
  const payload: AgentCallbackPayload = {
    p: params.publishRequestId,
    exp: nowSec() + ttl,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sigB64 = base64url(hmac(secret, agentCallbackSigningString(payload)));
  return `${payloadB64}.${sigB64}`;
}

export type VerifyAgentCallbackTokenResult = {
  ok: boolean;
  publishRequestId?: string;
};

/**
 * Verify an agent report-callback bearer against the expected publishRequestId.
 * NEVER throws on malformed input — returns `{ ok:false }`. Checks: parseable
 * payload + signature, constant-time HMAC match, not expired, and the bound
 * `publishRequestId` equals `expectedPublishRequestId`.
 */
export function verifyAgentCallbackToken(
  token: string | null | undefined,
  expectedPublishRequestId: string,
  opts?: { secret?: string }
): VerifyAgentCallbackTokenResult {
  const fail: VerifyAgentCallbackTokenResult = { ok: false };
  if (!token || typeof token !== 'string') return fail;
  if (!expectedPublishRequestId) return fail;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return fail;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload: AgentCallbackPayload;
  try {
    const parsed = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.p !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return fail;
    }
    payload = parsed as AgentCallbackPayload;
  } catch {
    return fail;
  }

  let secret: string;
  try {
    secret = opts?.secret ?? resolveSecret();
  } catch {
    return fail;
  }

  const expectedSig = hmac(secret, agentCallbackSigningString(payload));
  let providedSig: Buffer;
  try {
    providedSig = base64urlToBuffer(sigB64);
  } catch {
    return fail;
  }
  if (providedSig.length !== expectedSig.length) return fail;
  if (!timingSafeEqual(providedSig, expectedSig)) return fail;

  if (payload.exp <= nowSec()) return fail;
  if (payload.p !== expectedPublishRequestId) return fail;

  return { ok: true, publishRequestId: payload.p };
}

// ---------------------------------------------------------------------------
// AGENTIC MOD CODE-REVIEW (App Blocks P3, in-modal chat) — the agent pod's
// GATEWAY secret, DERIVED (no storage / no migration).
//
// The moderator's in-modal chat proxies to the review agent pod's OpenClaw
// gateway (`http://<agentName>.<ns>.svc.cluster.local:18789/v1/chat/completions`).
// The gateway expects a bearer. Rather than persist a per-review secret, civitai
// DERIVES it deterministically from NEXTAUTH_SECRET + the publishRequestId:
//   - `deriveAgentHooksToken(publishRequestId)` is passed to the pod at PROVISION
//     time (Job env `HOOKS_TOKEN`); the infra template feeds it into the pod's
//     fetch-bundle init and the pod uses it as its gateway secret basis.
//   - the gateway BEARER civitai sends on each chat = `sha256("gw-" + hooks)`.
// Both are pure functions of (NEXTAUTH_SECRET, publishRequestId): the pod holds
// HOOKS_TOKEN for its whole run and civitai RECOMPUTES the bearer for every chat
// turn, so they always match without any shared/stored state.
//
// DETERMINISTIC (no exp): unlike the `mr` / callback tokens above, these are
// stable derivations, not short-TTL bearers — the recompute-must-match invariant
// requires determinism. Domain-separated + distinct construction so neither can
// ever collide with the `mr` entry token or the callback bearer.
// ---------------------------------------------------------------------------

/** Domain-separation prefix for the derived per-review agent HOOKS token. Bump
 *  `v1` if the derivation shape changes (would require an infra-template bump). */
const AGENT_HOOKS_TOKEN_DOMAIN_PREFIX = 'agent-review-hooks:v1';

export type DeriveAgentHooksTokenOpts = {
  /** Injected for testability; defaults to env.NEXTAUTH_SECRET. */
  secret?: string;
};

/**
 * Derive the per-review agent HOOKS token: a domain-separated HMAC-SHA256 over
 * NEXTAUTH_SECRET keyed by the publishRequestId, hex-encoded. Deterministic and
 * distinct from the `mr` entry token and the callback bearer (different domain
 * prefix + a plain `:${publishRequestId}` binding, no expiry). Passed to the pod
 * at provision time as `HOOKS_TOKEN`.
 */
export function deriveAgentHooksToken(
  publishRequestId: string,
  opts?: DeriveAgentHooksTokenOpts
): string {
  const secret = opts?.secret ?? resolveSecret();
  return createHmac('sha256', secret)
    .update(`${AGENT_HOOKS_TOKEN_DOMAIN_PREFIX}:${publishRequestId}`)
    .digest('hex');
}

/**
 * The bearer the OpenClaw gateway expects = `sha256("gw-" + hooksToken)` (hex),
 * where `hooksToken = deriveAgentHooksToken(publishRequestId)`. civitai sends
 * this on every in-modal chat request; the pod computes the same value from the
 * HOOKS_TOKEN it was provisioned with, so the two match without shared state.
 */
export function deriveAgentGatewayBearer(
  publishRequestId: string,
  opts?: DeriveAgentHooksTokenOpts
): string {
  const hooks = deriveAgentHooksToken(publishRequestId, opts);
  return createHash('sha256').update(`gw-${hooks}`).digest('hex');
}
