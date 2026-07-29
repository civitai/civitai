import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * APP DEV TUNNEL — pure crypto primitives (no DB / Redis / k8s), so they are
 * unit-testable in isolation. This is the direct sibling of `review-session.ts`
 * (the mod review sandbox), with the "mod-bound" binding swapped for
 * "author-bound", and adds the tunnel-credential (sish `ssh -R` pubkey) helpers.
 *
 * Two distinct tokens live here — do not conflate them:
 *
 *   1. ENTRY TOKEN (author-bound, host-bound, ~120s) — the BROWSER-side
 *      cross-origin access token the authenticated `civitai.com/apps/dev/<id>`
 *      parent mints and injects into the iframe `src` as `?dev=<token>`. The
 *      `*.civit.ai` edge forwardAuth (`/api/internal/dev-tunnel-gate`) verifies it
 *      on the ENTRY document request. This is the exact review-sandbox `mr`-token
 *      pattern, re-keyed to the author's userId. It gates who may LOAD the tunnel.
 *
 *   2. TUNNEL CREDENTIAL (pubkey-bound) — the SERVER-side authorization for the
 *      CLI's `ssh -R` bind. The CLI generates an ephemeral SSH keypair and sends
 *      its PUBLIC key to `startDevTunnel`; the mint records it. When sish receives
 *      the reverse-tunnel bind it POSTs the presented pubkey (`auth_key`) to the
 *      sish authz callback, which looks the credential up BY FINGERPRINT and
 *      constant-time compares the full stored pubkey. This module owns the
 *      fingerprint + constant-time-compare helpers; the Redis-backed credential
 *      lifecycle lives in `dev-tunnel.service.ts`.
 *
 * SECURITY NOTE (why the pubkey is the boundary, and replay is inert): the
 * `auth_key` sish forwards is a PUBLIC key. Possessing it does NOT let an attacker
 * bind the tunnel — the SSH transport still requires the matching PRIVATE key
 * (standard pubkey auth), which never leaves the dev's machine. So an attacker who
 * replays the authz POST only re-authorizes the SAME userId's own tunnel binding
 * and gains nothing. Defense-in-depth on the callback is nonetheless: a shared
 * secret (only sish knows), a short-TTL credential, and a constant-time compare.
 */

// ---------------------------------------------------------------------------
// ENTRY token (author-bound, short-TTL, carried as `?dev=` on the iframe src)
// ---------------------------------------------------------------------------

/** ENTRY-token TTL in seconds. Intentionally short: mint (getServerSideProps /
 *  status poll) → iframe document load. A fresh URL is minted on every render so
 *  the live iframe never serves a stale token. */
export const DEV_TUNNEL_ACCESS_TOKEN_TTL_SECONDS = 120;

/** Domain-separation prefix for the short-TTL ENTRY token. Ensures this HMAC can
 *  never collide with the review-sandbox `mr` token or any other the app signs
 *  over the same NEXTAUTH_SECRET. Bump `v1` if the payload shape changes. */
const ENTRY_DOMAIN_PREFIX = 'dev-tunnel-mr:v1';

/** The unguessable dev host label: `dev-<16 hex>`. Exported so the mint, the
 *  route iframeSrc derivation, and the gate all validate the SAME shape. The
 *  16-hex (64-bit) random makes the host itself an unguessable secret on top of
 *  the entry-token gate (defence for T1). */
export const DEV_HOST_LABEL_REGEX = /^dev-[a-f0-9]{16}$/;

/** Full-host regex `^dev-<16hex>\.<escaped-domain>$`. Server-derives + validates
 *  the iframeSrc host (T6: never reflect a client-supplied URL). */
export function devHostRegexForDomain(appsDomain: string): RegExp {
  const escaped = appsDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^dev-[a-f0-9]{16}\\.${escaped}$`);
}

/** True iff `host` is a well-formed `dev-<16hex>.<appsDomain>` host. */
export function isValidDevHost(host: string | null | undefined, appsDomain: string): boolean {
  if (!host || typeof host !== 'string') return false;
  return devHostRegexForDomain(appsDomain).test(host);
}

/** Generate a fresh unguessable dev host label `dev-<16hex>` (8 random bytes). */
export function generateDevHostLabel(): string {
  return `dev-${randomBytes(8).toString('hex')}`;
}

type DevAccessPayload = {
  /** Author (app developer) user id the token is bound to. */
  u: number;
  /** dev host the token authorizes (`dev-<16hex>.<APPS_DOMAIN>`). */
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

function entrySigningString(p: DevAccessPayload): string {
  return `${ENTRY_DOMAIN_PREFIX}:${p.u}:${p.h}:${p.exp}`;
}

function hmac(secret: string, signingStr: string): Buffer {
  return createHmac('sha256', secret).update(signingStr).digest();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export type SignDevAccessTokenParams = {
  userId: number;
  host: string;
  /** Injected for testability; defaults to env.NEXTAUTH_SECRET. */
  secret?: string;
  /** Injected for testability; defaults to DEV_TUNNEL_ACCESS_TOKEN_TTL_SECONDS. */
  ttlSeconds?: number;
};

/**
 * Mint a compact `base64url(payload).base64url(sig)` dev-tunnel entry token bound
 * to (userId, host), valid for `ttlSeconds` (default 120s).
 */
export function signDevTunnelAccessToken(params: SignDevAccessTokenParams): string {
  const secret = params.secret ?? resolveSecret();
  const ttl = params.ttlSeconds ?? DEV_TUNNEL_ACCESS_TOKEN_TTL_SECONDS;
  const payload: DevAccessPayload = {
    u: params.userId,
    h: params.host,
    exp: nowSec() + ttl,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sigB64 = base64url(hmac(secret, entrySigningString(payload)));
  return `${payloadB64}.${sigB64}`;
}

export type VerifyDevAccessTokenResult = {
  ok: boolean;
  userId?: number;
};

/**
 * Verify a dev-tunnel entry token against the expected host. NEVER throws on
 * malformed input — returns `{ ok:false }`. Checks: structurally parseable
 * payload + signature, constant-time HMAC match, not expired, bound host equals
 * `expectedHost`.
 */
export function verifyDevTunnelAccessToken(
  token: string | null | undefined,
  expectedHost: string,
  opts?: { secret?: string }
): VerifyDevAccessTokenResult {
  const fail: VerifyDevAccessTokenResult = { ok: false };
  if (!token || typeof token !== 'string') return fail;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return fail;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let payload: DevAccessPayload;
  try {
    const parsed = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.u !== 'number' ||
      typeof parsed.h !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return fail;
    }
    payload = parsed as DevAccessPayload;
  } catch {
    return fail;
  }

  let secret: string;
  try {
    secret = opts?.secret ?? resolveSecret();
  } catch {
    return fail;
  }

  const expectedSig = hmac(secret, entrySigningString(payload));
  let providedSig: Buffer;
  try {
    providedSig = base64urlToBuffer(sigB64);
  } catch {
    return fail;
  }
  if (providedSig.length !== expectedSig.length) return fail;
  if (!timingSafeEqual(providedSig, expectedSig)) return fail;

  if (payload.exp <= nowSec()) return fail;
  if (payload.h !== expectedHost) return fail;

  return { ok: true, userId: payload.u };
}

// ---------------------------------------------------------------------------
// TUNNEL credential (sish `ssh -R` pubkey binding)
// ---------------------------------------------------------------------------

/**
 * Normalize an SSH public key to its stable comparison form: `<type> <base64>`
 * (drop any trailing comment + surrounding whitespace, collapse inner runs). An
 * OpenSSH pubkey line is `ssh-ed25519 AAAA... user@host` — the comment is
 * cosmetic and must NOT participate in the identity, or a reconnect that drops it
 * would fail to match. Returns '' for anything not shaped like a pubkey.
 */
export function normalizeSshPublicKey(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return '';
  const [type, key] = parts;
  // A base64 body is required; be strict so junk can't produce a stable
  // fingerprint that later collides.
  if (!/^[A-Za-z0-9+/=@.\-]+$/.test(type) || !/^[A-Za-z0-9+/=]+$/.test(key)) return '';
  return `${type} ${key}`;
}

/**
 * Stable fingerprint (sha256 hex of the normalized pubkey) used as the Redis
 * lookup key for the credential. This is only an INDEX — the authorization
 * decision is a constant-time compare of the full stored pubkey vs the presented
 * one (see `pubKeysMatch`), so a fingerprint collision alone can never authorize.
 */
export function fingerprintSshPublicKey(raw: string | null | undefined): string | null {
  const normalized = normalizeSshPublicKey(raw);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Constant-time equality of two SSH public keys (compared in normalized form).
 * Returns false (never throws) on malformed input or a length mismatch. This is
 * the authoritative authz check in the sish callback.
 */
export function pubKeysMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeSshPublicKey(a);
  const nb = normalizeSshPublicKey(b);
  if (!na || !nb) return false;
  const ba = Buffer.from(na, 'utf8');
  const bb = Buffer.from(nb, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Constant-time equality for the sish shared secret (self-authenticating the
 * callback so random internet cannot POST it). Never throws; a missing/empty
 * configured secret or a length mismatch is a definitive non-match.
 */
export function sharedSecretMatch(
  presented: string | null | undefined,
  configured: string | null | undefined
): boolean {
  if (!presented || !configured || typeof presented !== 'string' || typeof configured !== 'string') {
    return false;
  }
  const bp = Buffer.from(presented, 'utf8');
  const bc = Buffer.from(configured, 'utf8');
  if (bp.length !== bc.length) return false;
  return timingSafeEqual(bp, bc);
}

/** Resolve NEXTAUTH_SECRET lazily so the module stays import-cheap + testable
 *  (callers can inject `secret` directly to avoid env resolution). */
function resolveSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return secret;
}
