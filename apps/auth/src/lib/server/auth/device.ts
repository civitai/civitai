import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import { deviceCookieName, isSecureCookie } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';
import { cookieDomain } from './cookie';

// DEVICE-LEVEL account linking (docs/main-app-auth-cutover.md, section E). A browser is identified by an
// httpOnly `device` cookie; the hub keeps a per-device set of accounts that have authenticated on it, each
// with a `lastSwitchedAt`. Account-switch is authorized against THIS set (+ an active session) — never a
// client-held credential and never a User-to-User DB link, so there's no cross-device association and XSS
// can't read the device id. Accounts idle for >7d are pruned → a switch into them requires a fresh login.
//
// LAZY MATERIALIZATION (capacity): the set is ONLY written once a browser actually has ≥2 distinct linked
// accounts — the only case where the switcher is useful. A plain single-account login writes NOTHING (it would
// otherwise leave a 7-day per-browser hash for the ~84% of users who never switch, which had grown the
// `device:accounts:*` keyspace into the bulk of sysRedis). The "2nd account" signal is a session mint for
// userId X on a request whose existing valid session (the incoming civ-token cookie) belongs to a DIFFERENT
// userId Y → linkAccount materializes BOTH X and Y at that moment. touchAccount only REFRESHES an existing set.

const DEVICE_COOKIE = deviceCookieName(); // `__Secure-civ-device` in prod, `civ-device` in dev (env-derived)
// 7-day ROLLING TTL — refreshed on every login/switch/refresh while ≥2 accounts are linked. A browser that
// goes 7 days without any switcher activity forgets its account set entirely; nothing in the device store
// outlives the session it supports. (Shortened from 30d: the set is a convenience cache for the multi-account
// switcher, not a durable record — and a shorter horizon caps the keyspace this fills in sysRedis.)
const DEVICE_TTL_S = 7 * 24 * 60 * 60;
const ACCOUNT_IDLE_MS = DEVICE_TTL_S * 1000; // per-account: "hasn't switched to this account in 7 days → re-login"
const key = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}` as const;

const cookieOpts = {
  path: '/' as const,
  domain: cookieDomain(),
  httpOnly: true,
  secure: isSecureCookie(),
  sameSite: 'lax' as const,
};

/** Read the device id (or mint one) and ALWAYS (re)set the cookie so its 7-day TTL rolls. Call on login. */
export function getOrCreateDeviceId(cookies: Cookies): string {
  const id = cookies.get(DEVICE_COOKIE) ?? randomUUID();
  cookies.set(DEVICE_COOKIE, id, { ...cookieOpts, maxAge: DEVICE_TTL_S }); // re-set → rolling
  return id;
}

/** Read the device id without creating one (switch / list paths — no device cookie ⇒ no linked accounts). */
export function getDeviceId(cookies: Cookies): string | undefined {
  return cookies.get(DEVICE_COOKIE);
}

/** Re-set the (existing) device cookie to roll its 7-day TTL — pairs with touchAccount on a direct browser
 *  switch, so the device cookie doesn't expire while its redis set is still being refreshed. */
export function rollDeviceCookie(cookies: Cookies, deviceId: string): void {
  cookies.set(DEVICE_COOKIE, deviceId, { ...cookieOpts, maxAge: DEVICE_TTL_S });
}

/** Clear the device cookie on logout — like clearSession, the seamless-switch account set must not survive a
 *  sign-out on a shared machine. Clears the Domain-scoped cookie it was set with AND a host-only one of the same
 *  name (SvelteKit 2.x keys cookies by (domain, path, name), so both Set-Cookies emit) — a Domain-scoped delete
 *  can't remove a host-only `civ-device` of the same name, which would otherwise survive logout. */
export function clearDeviceCookie(cookies: Cookies): void {
  const domain = cookieDomain();
  const secure = isSecureCookie();
  cookies.delete(DEVICE_COOKIE, { path: '/', secure, domain });
  if (domain) cookies.delete(DEVICE_COOKIE, { path: '/', secure });
}

/**
 * REFRESH an account's `lastSwitchedAt` on this device's set — but ONLY if the set already EXISTS (i.e. the
 * browser is already in multi-account mode). On a set that doesn't exist yet (the common single-account login),
 * this is a NO-OP: it deliberately does NOT create a singleton hash. The set is first materialized by
 * `linkAccount` once a genuine 2nd distinct account appears. Callers that just want to keep the active account
 * fresh (authorize / session / legacy-exchange / refresh / switch) use this; the explicit switch path always
 * has an existing set (it's gated by `isLinkedAndFresh`), so its refresh still lands. Best-effort.
 */
export async function touchAccount(deviceId: string, userId: number): Promise<void> {
  const sys = getSysRedis();
  if (!sys) return;
  try {
    // Atomic-enough for a hash field: hSet only when at least one field already exists. We can't conditionally
    // hSet a single field, so gate on key existence first. A racing first-create between the two calls is
    // harmless — the set being created concurrently is exactly the case where we DO want the refresh to land.
    if (!(await sys.exists(key(deviceId)))) return; // no set yet ⇒ single-account ⇒ write nothing
    await sys.hSet(key(deviceId), String(userId), String(Date.now()));
    await sys.expire(key(deviceId), DEVICE_TTL_S);
  } catch {
    // best-effort — a redis blip must not fail login/switch
  }
}

/**
 * LAZY-CREATE the device set when a SECOND distinct account is being added to this browser. Call on a login/
 * session mint for `newUserId` whenever the request already carries a valid session for `existingUserId`.
 *
 *  - existing set present (already multi-account)  → just refresh `newUserId` (delegates to touchAccount).
 *  - no set yet AND existingUserId is a DIFFERENT user → MATERIALIZE BOTH accounts (backfill `existingUserId`
 *    with its own `lastSwitchedAt` so the first account isn't silently dropped) and set the TTL.
 *  - no set yet AND no distinct existing user (ordinary single-account login) → NO-OP (write nothing).
 *
 * This is the only writer that may create a `device:accounts:*` key, so single-account users never get one.
 * Best-effort: a redis blip must never fail the login it rides on.
 */
export async function linkAccount(
  deviceId: string,
  newUserId: number,
  existingUserId?: number | null
): Promise<void> {
  const sys = getSysRedis();
  if (!sys) return;
  try {
    if (await sys.exists(key(deviceId))) {
      // Already multi-account on this browser — just slide the new account's clock + roll the TTL.
      await sys.hSet(key(deviceId), String(newUserId), String(Date.now()));
      await sys.expire(key(deviceId), DEVICE_TTL_S);
      return;
    }
    // No set yet. Only materialize when a genuine 2nd distinct account is appearing.
    if (existingUserId == null || existingUserId === newUserId) return;
    const now = String(Date.now());
    // Backfill the FIRST account (existingUserId) alongside the new one — the set was never written for it
    // (single-account users get no key), so this is the moment to record both. Same timestamp is fine: both
    // are active right now, and listAccounts sorts by it (ties are arbitrary but both are fresh).
    //
    // ATOMIC materialize: write BOTH fields AND the TTL in a single EVAL. A non-atomic hSet→hSet→expire
    // sequence that died mid-way would leave a TTL-LESS key — reintroducing the exact unbounded-growth
    // failure this PR exists to fix. hSetMultiWithExpire guarantees the key is never observable with
    // fields but no TTL.
    await sys.hSetMultiWithExpire(
      key(deviceId),
      [String(existingUserId), now, String(newUserId), now],
      DEVICE_TTL_S
    );
  } catch {
    // best-effort — a redis blip must not fail login
  }
}

/** The device's linked accounts (idle >7d pruned). */
export async function listAccounts(
  deviceId: string
): Promise<{ userId: number; lastSwitchedAt: number }[]> {
  const sys = getSysRedis();
  if (!sys) return [];
  let all: Record<string, string>;
  try {
    all = await sys.hGetAll<string>(key(deviceId));
  } catch {
    return [];
  }
  const now = Date.now();
  const fresh: { userId: number; lastSwitchedAt: number }[] = [];
  const stale: string[] = [];
  for (const [uid, ts] of Object.entries(all)) {
    const lastSwitchedAt = Number(ts);
    if (!Number.isFinite(lastSwitchedAt) || now - lastSwitchedAt > ACCOUNT_IDLE_MS) stale.push(uid);
    else fresh.push({ userId: Number(uid), lastSwitchedAt });
  }
  if (stale.length) await sys.hDel(key(deviceId), stale).catch(() => {});
  return fresh.sort((a, b) => b.lastSwitchedAt - a.lastSwitchedAt);
}

/** True iff the target is linked to this device AND fresh (<7d). The switch authorization check. */
export async function isLinkedAndFresh(deviceId: string, userId: number): Promise<boolean> {
  const sys = getSysRedis();
  if (!sys) return false;
  try {
    const ts = await sys.hGet<string>(key(deviceId), String(userId));
    if (!ts) return false;
    return Date.now() - Number(ts) <= ACCOUNT_IDLE_MS;
  } catch {
    return false;
  }
}

/** Remove an account from this device's set (explicit "remove from this browser"). */
export async function removeAccount(deviceId: string, userId: number): Promise<void> {
  const sys = getSysRedis();
  if (!sys) return;
  await sys.hDel(key(deviceId), String(userId)).catch(() => {});
}
