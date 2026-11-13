import { loadAuthEnv } from './env';

// Bound every hub hop so a stalled hub / edge fails fast instead of hanging the authed request (matches the
// token identity leg). A caller that arms its own signal (e.g. session-token-client) is respected.
const HUB_FETCH_TIMEOUT_MS = 1500;

/**
 * The hub origin (the token issuer, `AUTH_JWT_ISSUER`), trailing slashes stripped. Returns null when
 * unconfigured so callers can no-op a request path instead of throwing. This is the PUBLIC origin used for
 * URL/redirect BUILDING (spoke-guard, first-party-bridge) — NOT the fetch target (see hubFetch). Single source
 * for the spoke→hub clients (device / session-token / impersonation) + the session-client write path.
 */
export function hubBaseUrl(): string | null {
  const url = loadAuthEnv().AUTH_JWT_ISSUER;
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * The base hubFetch actually TARGETS: the in-cluster hub svc (`AUTH_HUB_INTERNAL_URL`) when set, else the
 * public `AUTH_JWT_ISSUER` (today's behavior). Unlike the token identity leg there is NO spoof concern here —
 * hubFetch always targets the operator-configured trusted issuer, never an attacker-controlled `claims.iss` —
 * so we prefer the internal address unconditionally. This removes the CF-edge hairpin for the API-key/OAuth
 * by-id read (getSessionUserById) + the write paths + the device/session-token/impersonation clients. It is
 * cookie-safe: the hub derives its cookie `Domain` from `AUTH_JWT_ISSUER` (unchanged), never the request Host.
 */
function hubFetchBase(): string | null {
  const env = loadAuthEnv();
  const base = env.AUTH_HUB_INTERNAL_URL ?? env.AUTH_JWT_ISSUER;
  return base ? base.replace(/\/+$/, '') : null;
}

/**
 * STRICT hub fetch — the server-side primitive every spoke→hub client routes through, so the package provably
 * only ever talks to the hub, never a relative/spoke path. Routes in-cluster via `AUTH_HUB_INTERNAL_URL` when
 * set (else the public issuer) and bounds the hop with a timeout. Throws if the hub isn't configured; callers
 * wrap in try/catch and fall back to their own empty/null result.
 */
export function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = hubFetchBase();
  if (!base) throw new Error('[@civitai/auth] hub not configured (AUTH_JWT_ISSUER)');
  // Respect a caller-armed signal (session-token-client sets its own 2500ms), else arm the default timeout.
  const signal = init?.signal ?? AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS);
  return fetch(`${base}${path}`, { ...init, signal });
}

/** The user session a hub call acts on: the session token and, when the browser has one, its device id. */
export interface SessionRef {
  token?: string;
  deviceId?: string;
}

const PARITY_TTL_MS = 10 * 60_000;
let parity: 0 | 1 | null = null;
let parityAt = -Infinity;
let parityInflight: Promise<void> | null = null;

/** Re-probe the hub now. Exported for tests; callers use `internalShapeReady`. */
export function refreshInternalParity(): Promise<void> {
  return (parityInflight ??= probeInternalParity()
    .then(
      (v) => {
        parity = v;
      },
      () => undefined
    )
    .finally(() => {
      parityAt = Date.now();
      parityInflight = null;
    }));
}

/**
 * Whether the hub has confirmed this app's `AUTH_INTERNAL_TOKEN` within the last ten minutes. Never waits:
 * a stale answer starts a background probe and the call goes out in the legacy shape until it lands, so a
 * credential that does not match the hub's leaves the app working as before.
 */
export function internalShapeReady(): boolean {
  if (Date.now() - parityAt >= PARITY_TTL_MS) void refreshInternalParity();
  return parity === 1;
}

/**
 * Headers and body for a hub call made on a user's behalf. Once `internalShapeReady`, the caller's own
 * credential is the Bearer and the session travels in the JSON body beside `fields`; until then the session
 * goes in `legacyHeaders` as it always has.
 */
export function sessionCall(
  session: SessionRef,
  legacyHeaders: Record<string, string>,
  fields?: Record<string, unknown>
): { headers: Record<string, string>; body?: string; internal: boolean } {
  const internal = internalShapeReady() && loadAuthEnv().AUTH_INTERNAL_TOKEN;
  if (internal) {
    return {
      headers: { authorization: `Bearer ${internal}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, token: session.token, deviceId: session.deviceId }),
      internal: true,
    };
  }
  if (!fields) return { headers: legacyHeaders, internal: false };
  return {
    headers: { ...legacyHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(fields),
    internal: false,
  };
}

/**
 * 1 when the hub accepts this app's `AUTH_INTERNAL_TOKEN`, 0 when it refuses it or none is set. Throws when the
 * hub gives no answer either way (unreachable, or a build without `/api/auth/internal-ping`), since that says
 * nothing about the credential.
 */
export async function probeInternalParity(): Promise<0 | 1> {
  const internal = loadAuthEnv().AUTH_INTERNAL_TOKEN;
  if (!internal) return 0;
  const res = await hubFetch('/api/auth/internal-ping', {
    headers: { authorization: `Bearer ${internal}` },
  });
  if (res.status === 204) return 1;
  if (res.status === 401) return 0;
  throw new Error(`[@civitai/auth] internal-ping answered ${res.status}`);
}
