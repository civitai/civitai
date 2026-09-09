import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import { cookiePrefix, isSecureCookie } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';
import { registrableDomainOfUrl } from './domain';
import { crossDomainHandoffTotal, crossDomainHandoffConsumeTotal } from '../metrics';

// PENDING AUTHORIZATION IDENTITY — the hub's answer to "who is this login for?" when writing the hub's own
// session cookie would be wrong.
//
// The hub's `civ-token` is Domain=`.civitai.com`, which is ALSO civitai.com's session cookie (same name, same
// scope — RFC 6265 treats `civitai.com` and `.civitai.com` as one slot). So a login the user performs in order
// to reach a spoke on a DIFFERENT registrable domain — civitai.red — silently re-pointed civitai.com to that
// account. Switching back on .red then used the seamless device switch, which never touches the hub cookie, so
// .com stayed on the other account. That asymmetry is the bug (ClickUp 868kxch09, report 2).
//
// /api/auth/oauth/authorize needs an authenticated user on the hop AFTER the login callback in order to issue
// the code, and it reads `locals.user` from the session cookie — which is exactly the coupling. This module is
// the narrow alternative: an opaque, single-use, short-lived id in a PATH-SCOPED cookie that only
// /api/auth/oauth/authorize ever receives, backed by a sysRedis record bound to the spoke's registrable domain.
//
// Deliberately OPAQUE, not a signed token: a signed token carrying a user id is a bearer credential, and the
// shared verifier only refuses `purpose: 'swap'` — a new purpose would be accepted as a session if it ever
// reached the `civ-token` slot. An opaque id has nothing to replay; it is meaningless without the redis record.

// Hub-local by design: no spoke may read this, so unlike `civ-token`/`civ-device` the name is NOT a shared
// contract in @civitai/auth. Only the `__Secure-` prefix rule is shared, so dev and prod agree.
const COOKIE = `${cookiePrefix(isSecureCookie())}civ-pending`;
// The whole lifetime is one redirect hop (login callback -> /authorize). Short enough that an abandoned login
// leaves nothing usable, long enough to absorb a slow redirect.
const TTL_S = 120;
// Host-only (no Domain) so it never reaches a `*.civitai.com` spoke, and path-scoped so the browser sends it
// to the ONE endpoint entitled to consume it. Lax because the hop that carries it is the spoke's top-level
// GET redirect back to /authorize — cross-site.
const COOKIE_OPTS = {
  path: '/api/auth/oauth/authorize' as const,
  httpOnly: true,
  secure: isSecureCookie(),
  sameSite: 'lax' as const,
};

const key = (id: string) => `${REDIS_SYS_KEYS.SESSION.PENDING_AUTHZ}:${id}` as const;

export interface PendingAuthz {
  userId: number;
  /**
   * The REGISTRABLE DOMAIN (eTLD+1) of the spoke this identity was minted for — `civitai.red`, not
   * `https://www.civitai.red`.
   *
   * Deliberately coarser than the origin. The two sides are derived on different requests by different code:
   * the record's from the login-start returnUrl, the authorization's from the spoke's `resolveSelfOrigin` on a
   * later hop. Those disagree on host variations this codebase has already had to compensate for
   * (`first-party-bridge.ts` Domain-scopes its bridge cookie precisely because www↔apex was observed in
   * prod), and `SERVER_DOMAIN_*_ALIASES` means a colour genuinely serves several hosts. An exact-origin match
   * would refuse those legitimate logins — and a refusal silently falls back to writing the hub session,
   * i.e. straight back to the bug this exists to fix.
   *
   * Coarsening is safe because this is NOT the control on where a code may be sent. That is
   * `redirectUriMatches` against the registry-synthesized exact callback (authorize/+server.ts), which
   * already fails closed for any unregistered host. This binding exists only to stop a record minted while
   * signing in for one spoke FAMILY being spent on another — red vs green vs preview — which is exactly the
   * boundary the whole change is about.
   */
  domain: string;
}

/**
 * Record `userId` as the identity for an in-flight authorization to a spoke on `domain` (a registrable
 * domain), and set the cookie that carries it. Returns false when nothing was stored — the caller MUST then
 * fall back to writing the hub session cookie, because an authorization with no identity anywhere is a login
 * that dead-ends at /login.
 */
export async function issuePendingAuthz(
  cookies: Cookies,
  userId: number,
  domain: string
): Promise<boolean> {
  const sys = getSysRedis();
  if (!sys) {
    crossDomainHandoffTotal.inc({ outcome: 'fell_back' });
    return false;
  }
  const id = randomUUID();
  try {
    await sys.set(key(id), JSON.stringify({ userId, domain } satisfies PendingAuthz), {
      EX: TTL_S,
    });
  } catch {
    // redis blip — the caller degrades to the hub session cookie rather than failing the login
    crossDomainHandoffTotal.inc({ outcome: 'fell_back' });
    return false;
  }
  cookies.set(COOKIE, id, { ...COOKIE_OPTS, maxAge: TTL_S });
  crossDomainHandoffTotal.inc({ outcome: 'issued' });
  return true;
}

/**
 * Consume the pending identity for THIS authorization, if the request carries one. Returns the userId only
 * when the redirect_uri being authorized is on the domain the record was minted for.
 *
 * Single-use ON MATCH: the record is deleted and the cookie cleared before the caller acts on it, so a replay
 * (a re-run of /authorize, a back button) finds nothing.
 *
 * On a MISMATCH the record and cookie are left ALONE — deliberately. The cookie is path-scoped to this
 * endpoint, but this endpoint also serves every third-party authorization, so a concurrent authorize in
 * another tab would otherwise burn a record it has no claim to and strand the login it belonged to. A
 * mismatch yields no identity, so leaving it grants nothing: an id is only useful on the domain it was minted
 * for, and reaching this code at all already requires the browser that holds the HttpOnly cookie.
 *
 * A refusal is not a lockout: /authorize bounces to /login with a hub-RELATIVE returnUrl, which is
 * same-scope, so that second login writes the hub session normally and the flow completes — at the cost of
 * one extra round-trip that lands on the pre-fix behaviour.
 */
export async function consumePendingAuthz(
  cookies: Cookies,
  redirectUri: string | undefined
): Promise<number | undefined> {
  const id = cookies.get(COOKIE);
  if (!id) return undefined;

  const sys = getSysRedis();
  if (!sys) {
    crossDomainHandoffConsumeTotal.inc({ outcome: 'absent' });
    return undefined;
  }
  let raw: string | null;
  try {
    raw = await sys.get<string>(key(id));
  } catch {
    crossDomainHandoffConsumeTotal.inc({ outcome: 'absent' });
    return undefined;
  }
  if (!raw) {
    clearPendingAuthz(cookies); // expired or already spent — stop sending it
    crossDomainHandoffConsumeTotal.inc({ outcome: 'absent' });
    return undefined;
  }

  let record: PendingAuthz;
  try {
    record = JSON.parse(raw) as PendingAuthz;
  } catch {
    clearPendingAuthz(cookies);
    await sys.del(key(id)).catch(() => undefined);
    crossDomainHandoffConsumeTotal.inc({ outcome: 'absent' });
    return undefined;
  }

  const target = redirectUri ? registrableDomainOfUrl(redirectUri) : undefined;
  if (!target || target !== record.domain) {
    // Not ours — leave the record and cookie for the flow they belong to.
    crossDomainHandoffConsumeTotal.inc({ outcome: 'domain_mismatch' });
    return undefined;
  }

  clearPendingAuthz(cookies);
  await sys.del(key(id)).catch(() => undefined);
  // A record whose userId didn't survive the round trip is a corrupt record, not a hand-off — counting it as
  // `matched` would inflate the very number the operator reads against `issued` to tell if this is working.
  if (!Number.isFinite(record.userId)) {
    crossDomainHandoffConsumeTotal.inc({ outcome: 'absent' });
    return undefined;
  }
  crossDomainHandoffConsumeTotal.inc({ outcome: 'matched' });
  return record.userId;
}

/**
 * WHO this authorization is for: the pending record if one was minted for this spoke, otherwise the hub
 * session.
 *
 * 🔴 Preferring the record over the session is the whole point. The record only exists because the hub cookie
 * was deliberately left pointing at the PREVIOUS user, so on the one flow where both are present — "add
 * account" on civitai.red while signed in on civitai.com as someone else — using the cookie issues the code
 * for the account the user just switched AWAY from.
 *
 * 🔴 And it FAILS CLOSED. Once a record has been spent, `sessionUser` is no longer an acceptable answer: it
 * is by construction the account being switched away from. If the record's user cannot be resolved (a db
 * blip, a deleted row) the caller gets `undefined` and must send the browser back to /login — which recovers
 * correctly, because that second login carries a hub-relative returnUrl, writes the hub session normally and
 * completes. Falling back to the session instead would silently issue the code for the wrong account.
 */
export async function resolveAuthorizingUser<User>(opts: {
  cookies: Cookies;
  redirectUri: string | undefined;
  sessionUser: User | undefined;
  resolveUser: (userId: number) => Promise<User | null>;
}): Promise<User | undefined> {
  const { cookies, redirectUri, sessionUser, resolveUser } = opts;
  const pendingUserId = await consumePendingAuthz(cookies, redirectUri);
  if (pendingUserId === undefined) return sessionUser; // no record for this flow — ordinary session request
  return (await resolveUser(pendingUserId).catch(() => null)) ?? undefined;
}

function clearPendingAuthz(cookies: Cookies): void {
  cookies.delete(COOKIE, { path: COOKIE_OPTS.path, secure: COOKIE_OPTS.secure });
}
