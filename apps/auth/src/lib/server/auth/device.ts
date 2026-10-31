import { randomUUID } from 'crypto';
import type { Cookies } from '@sveltejs/kit';
import { DEVICE_COOKIE_BASE, deviceCookieName, isSecureCookie } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { evalSys, getSysRedis } from '../redis';
import { clearOtherCookieNames, cookieDomain } from './cookie';

// DEVICE-LEVEL account linking (docs/main-app-auth-cutover.md, section E). A browser is identified by an
// httpOnly `device` cookie; the hub keeps a per-device set of accounts that have authenticated on it, each
// with a `lastSwitchedAt`. Account-switch is authorized against THIS set (+ an active session) — never a
// client-held credential and never a User-to-User DB link, so there's no cross-device association and XSS
// can't read the device id. Accounts idle for >30d are pruned → a switch into them requires a fresh login.
//
// LAZY MATERIALIZATION (capacity): the set is ONLY written once a browser actually has ≥2 distinct linked
// accounts — the only case where the switcher is useful. A plain single-account login writes NOTHING (it would
// otherwise leave a per-browser hash for the ~84% of users who never switch, which had grown the
// `device:accounts:*` keyspace into the bulk of sysRedis). The "2nd account" signal is a session mint for
// userId X on a request whose existing valid session (the incoming civ-token cookie) belongs to a DIFFERENT
// userId Y → linkAccount materializes BOTH X and Y at that moment. touchAccount only REFRESHES an existing set.

const DEVICE_COOKIE = deviceCookieName(); // `__Secure-civ-device` in prod, `civ-device` in dev (env-derived)
// 30-day ROLLING TTL — matches AUTH_SESSION_MAX_AGE (the session lifetime). Refreshed on every
// login/switch/refresh while ≥2 accounts are linked; a browser idle 30 days forgets its account set and a
// switch-into requires a fresh login. The keyspace is bounded by LAZY MATERIALIZATION above (only ~0.01% of
// browsers are ever multi-account → ~1k keys steady-state), NOT by this TTL — so it's purely the shared-device
// "seamless switch-back" / re-auth window (a security/UX knob), not a capacity lever.
const DEVICE_TTL_S = 30 * 24 * 60 * 60;
const ACCOUNT_IDLE_MS = DEVICE_TTL_S * 1000; // per-account: "hasn't switched to this account in 30 days → re-login"
const key = (deviceId: string) => `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}` as const;

const cookieOpts = {
  path: '/' as const,
  domain: cookieDomain(),
  httpOnly: true,
  secure: isSecureCookie(),
  sameSite: 'lax' as const,
};

/** Read the device id (or mint one) and ALWAYS (re)set the cookie so its 30-day TTL rolls. Call on login. */
export function getOrCreateDeviceId(cookies: Cookies): string {
  const id = cookies.get(DEVICE_COOKIE) ?? randomUUID();
  cookies.set(DEVICE_COOKIE, id, { ...cookieOpts, maxAge: DEVICE_TTL_S }); // re-set → rolling
  return id;
}

/** Give this browser a new device id, leaving whatever list the old one had behind. */
export function rotateDeviceId(cookies: Cookies): string {
  const id = randomUUID();
  cookies.set(DEVICE_COOKIE, id, { ...cookieOpts, maxAge: DEVICE_TTL_S });
  return id;
}

/** Read the device id without creating one (switch / list paths — no device cookie ⇒ no linked accounts). */
export function getDeviceId(cookies: Cookies): string | undefined {
  return cookies.get(DEVICE_COOKIE);
}

/** Re-set the (existing) device cookie to roll its 30-day TTL — pairs with touchAccount on a direct browser
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
  clearOtherCookieNames(cookies, DEVICE_COOKIE_BASE, DEVICE_COOKIE);
}

// Refreshes an account already in a multi-account list; never adds one.
const TOUCH_SCRIPT = `
  if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 and redis.call('HLEN', KEYS[1]) >= 2 then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return 1
  end
  return 0
`;

/**
 * Slide an account's `lastSwitchedAt` and the list's TTL, only when the account is already in a list of ≥2.
 * Never adds an account (only `linkAccount` does, with proof). Lists with <2 fields are left to expire: existing
 * single-account keys must drain, and refreshing them would stop that. Best-effort.
 */
export async function touchAccount(deviceId: string, userId: number): Promise<void> {
  try {
    await evalSys(
      TOUCH_SCRIPT,
      [key(deviceId)],
      [String(userId), String(Date.now()), String(DEVICE_TTL_S)]
    );
  } catch {
    // best-effort — a redis blip must not fail login/switch
  }
}

// No list: create one with both accounts when a distinct prior account is signed in (2), else write nothing (0).
// A list: joined (1) by an account already in it and used within ACCOUNT_IDLE_MS, or by a sign-in made while one
// of its accounts is signed in on this browser (the prior hub session); otherwise refused (-1).
// ARGV: new user, prior user ('' if none), now (ms), TTL (s), idle limit (ms).
const JOIN_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then
    if ARGV[2] ~= '' and ARGV[2] ~= ARGV[1] then
      redis.call('HSET', KEYS[1], ARGV[2], ARGV[3], ARGV[1], ARGV[3])
      redis.call('EXPIRE', KEYS[1], ARGV[4])
      return 2
    end
    return 0
  end
  local own = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '')
  local recent = own ~= nil and tonumber(ARGV[3]) - own <= tonumber(ARGV[5])
  if recent or (ARGV[2] ~= '' and redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1) then
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return 1
  end
  return -1
`;

/**
 * Add a signed-in account to this browser's account list (the switcher). `priorUserId` is the user of the
 * verified hub session the browser held before this sign-in, never a value from the request.
 *
 * `'joined'`: the account is in a list on this device. `'none'`: there is no list (a single-account browser).
 * `'rotate'`: the browser has a list this sign-in can't show it belongs to; the caller moves the browser to a
 * new device id.
 */
export async function linkAccount(
  deviceId: string,
  newUserId: number,
  priorUserId?: number | null
): Promise<'joined' | 'none' | 'rotate'> {
  const result = Number(
    await evalSys(
      JOIN_SCRIPT,
      [key(deviceId)],
      [
        String(newUserId),
        priorUserId != null ? String(priorUserId) : '',
        String(Date.now()),
        String(DEVICE_TTL_S),
        String(ACCOUNT_IDLE_MS),
      ]
    )
  );
  if (result === -1) return 'rotate';
  return result >= 1 ? 'joined' : 'none';
}

/** Both the caller's principal and the target are in this browser's account list and used within 30 days. */
export async function canSwitch(
  deviceId: string,
  principal: number,
  target: number
): Promise<boolean> {
  return (
    (await isLinkedAndFresh(deviceId, principal)) && (await isLinkedAndFresh(deviceId, target))
  );
}

/** The device's linked accounts (idle >30d pruned). */
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

/** True iff the target is linked to this device AND fresh (<30d). The switch authorization check. */
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
