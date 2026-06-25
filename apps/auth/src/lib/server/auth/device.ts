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
// can't read the device id. Accounts idle for >30d are pruned → a switch into them requires a fresh login.

const DEVICE_COOKIE = deviceCookieName(); // `__Secure-civ-device` in prod, `civ-device` in dev (env-derived)
// 30-day ROLLING TTL — same horizon as the session, refreshed on every login/switch. A browser idle 30 days
// forgets its account set entirely; nothing in the device store outlives the session it supports.
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
 *  sign-out on a shared machine. Same scope (path + cookieDomain) it was set with so the browser drops it. */
export function clearDeviceCookie(cookies: Cookies): void {
  cookies.delete(DEVICE_COOKIE, { path: '/', domain: cookieDomain() });
}

/** Add or refresh an account on this device's set (login + each switch touch `lastSwitchedAt`). */
export async function touchAccount(deviceId: string, userId: number): Promise<void> {
  const sys = getSysRedis();
  if (!sys) return;
  try {
    await sys.hSet(key(deviceId), String(userId), String(Date.now()));
    await sys.expire(key(deviceId), DEVICE_TTL_S);
  } catch {
    // best-effort — a redis blip must not fail login/switch
  }
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
