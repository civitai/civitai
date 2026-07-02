import { json, type RequestHandler } from '@sveltejs/kit';
import { createHash, timingSafeEqual } from 'crypto';
import { oauthModel } from '$lib/server/oauth/model';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { mintUserSession } from '$lib/server/auth/session';
import { touchAccount } from '$lib/server/auth/device';
import { consumeOidcContext } from '$lib/server/oauth/oidc-nonce';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { safeClientAddress } from '$lib/server/oauth/client-address';
import { parseBody } from '$lib/server/oauth/http';

// POST /api/auth/oauth/session — FIRST-PARTY session exchange (BFF, Phase 3).
//
// The spoke's /api/auth/callback calls this SERVER-TO-SERVER with the authorization code + PKCE verifier;
// the hub validates the code and returns a civ-token SESSION (the thin ES256 token the spoke sets as its
// session cookie) — NOT an OAuth Bearer/API token. This is deliberately SEPARATE from /token: only the
// trusted first-party spoke clients can reach it, and /token can therefore never mint an account session
// (so a client-flag mistake can't escalate a third-party app into a full session).
//
// Trust boundary (no client secret — these are public PKCE clients, BFF pattern):
//   1. a valid, unexpired, hub-issued authorization code bound to the presenting client_id,
//   2. the code's callback host is a FIRST-PARTY one (in the TrustedSpokeDomain registry) — a third-party
//      code resolves to a DB client whose origin isn't registered, so it's rejected here,
//   3. PKCE: S256(code_verifier) === the stored code_challenge,
//   4. the code is consumed exactly once before the session is minted (no replay).

const bad = (error: string, description?: string, status = 400) =>
  json({ error, ...(description ? { error_description: description } : {}) }, { status });

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await parseBody(request);
  const code = typeof body.code === 'string' ? body.code : '';
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  // getClientAddress() THROWS (not empty) when ADDRESS_HEADER=x-forwarded-for is configured but the header is
  // absent — e.g. an internal-routed spoke call that bypasses Traefik. safeClientAddress degrades to undefined
  // instead of 500ing the whole exchange (which is what broke ~45% of first-party logins). See client-address.ts.
  const ip = safeClientAddress(getClientAddress);

  if (!code || !verifier) {
    return bad('invalid_request', 'Missing code or code_verifier');
  }

  // Generous flood-guard (the caller is the spoke server, not the user — see rate-limit.ts). Keeps this
  // unauthenticated endpoint from being hammered before it does any redis/crypto/DB work. Normally keyed on the
  // real client IP (the spoke forwards the end-user's XFF). When the IP is unavailable, DO NOT collapse to a
  // single global 'unknown' key — that pools EVERY first-party exchange into one 300/min bucket and would 429
  // under load — degrade to the request's client_id so the guard stays per-tenant (firstparty-civitai_com/_red).
  const rateLimitKey = ip ?? (clientId ? `client:${clientId}` : 'unknown');
  if (!(await checkOAuthRateLimit('session', rateLimitKey))) {
    return bad('rate_limited', 'Too many session requests', 429);
  }

  // The code must exist, be unexpired, and belong to THIS client.
  const authCode = await oauthModel.getAuthorizationCode(code);
  if (!authCode || !authCode.client || authCode.client.id !== clientId) {
    return bad('invalid_grant', 'Invalid authorization code');
  }

  // Only a FIRST-PARTY code may be exchanged for a SESSION. First-party-ness is the resolved client's
  // IDENTITY — a hub-SYNTHESIZED client (no OauthClient row), surfaced as `isFirstParty` by resolveClientLite
  // (which getAuthorizationCode runs). A REGISTERED (DB-row) third-party client is `isFirstParty: false`
  // EVEN IF its redirect_uri origin is a trusted spoke domain it claimed at registration — so /token stays
  // the only path for third-party tokens and /session can never mint a session for a third-party app.
  if (!(authCode.client as { isFirstParty?: boolean }).isFirstParty) {
    return bad('invalid_client', 'Not a first-party client', 401);
  }

  if (authCode.expiresAt.getTime() < Date.now()) {
    await oauthModel.revokeAuthorizationCode(authCode);
    return bad('invalid_grant', 'Authorization code expired');
  }

  // Gate 3 — PKCE (S256 only; /authorize rejects anything else). expected = base64url(sha256(verifier)),
  // compared timing-safely.
  if (authCode.codeChallengeMethod !== 'S256' || !authCode.codeChallenge) {
    return bad('invalid_grant', 'Missing or unsupported PKCE challenge');
  }
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(authCode.codeChallenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return bad('invalid_grant', 'PKCE verification failed');
  }

  // Consume the code exactly once BEFORE minting. revokeAuthorizationCode reports whether THIS call
  // removed it (atomic HDEL) — so under a concurrent double-redemption only one request proceeds; the
  // racer (and any replay) gets false here and is rejected, with no second session minted.
  const consumed = await oauthModel.revokeAuthorizationCode(authCode);
  if (!consumed) return bad('invalid_grant', 'Authorization code already used');

  const userId =
    typeof authCode.user?.id === 'number' ? authCode.user.id : Number(authCode.user?.id);
  if (!Number.isFinite(userId)) return bad('invalid_grant', 'Invalid code subject');

  // Resolve the rich user (confirms existence) and mint the thin session token. mintUserSession only uses
  // user.id (sub + jti + revocation tracking); the spoke re-derives the rich user per request.
  const user = await getOrProduceSessionUser(userId).catch(() => null);
  if (!user) return bad('invalid_grant', 'Unknown user');

  const token = await mintUserSession(user);

  // Device set (account switcher): the hub stashed its shared `.civitai.com` device id with the code at
  // /authorize. Register this account under it and hand the SAME id back so the spoke writes it as its own
  // civ-device — so e.g. civitai.red joins the SAME device set as civitai.com and the switcher matches across
  // domains. Best-effort: a missing/redis-less device id just means no switcher entry, never a failed login.
  const { deviceId } = await consumeOidcContext(code);
  if (deviceId) await touchAccount(deviceId, userId);

  logOAuthEvent({
    type: 'token.issued',
    userId,
    clientId,
    ip: ip ?? 'unknown',
    metadata: { grant_type: 'first_party_session' },
  });

  // The spoke sets `token` as its session cookie and `deviceId` as its civ-device (via setSessionCookie), so
  // its session + device set match the rest of the family. Same civ-token shape the swap exchange produced.
  return json({ token, deviceId });
};
