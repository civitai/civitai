import { familyId, type SessionClaims } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';
import { sessions } from './registry';

// A family is every session descended from one sign-in on one browser (see @civitai/auth `familyClaims`).
// These records let the hub tell a family is still in use, and end every family a browser signed in with.

const DAY_S = 24 * 60 * 60;
const FAMILY_LIVE_TTL_S = 30 * DAY_S;
// Outlasts the 90-day session limit, so a family's membership can't lapse while its sessions are accepted.
const DEVICE_FAMILIES_TTL_S = 91 * DAY_S;

const deviceFamiliesKey = (deviceId: string) =>
  `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${deviceId}` as const;
const deviceAccountsKey = (deviceId: string) =>
  `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}` as const;

/** Record that `family` was just used. Best-effort. */
export async function markFamilyLive(family: string | undefined): Promise<void> {
  const sys = getSysRedis();
  if (!sys || !family) return;
  try {
    await sys.hSet(REDIS_SYS_KEYS.SESSION.FAMILY_LIVE, family, String(Date.now()));
    await sys.hExpire(REDIS_SYS_KEYS.SESSION.FAMILY_LIVE, family, FAMILY_LIVE_TTL_S);
  } catch {
    // best-effort
  }
}

/** Remember that `family` signed in on this browser, so signing out here ends it too. Best-effort. */
export async function addDeviceFamily(
  deviceId: string | undefined,
  family: string | undefined
): Promise<void> {
  const sys = getSysRedis();
  if (!sys || !deviceId || !family) return;
  try {
    await sys.sAdd(deviceFamiliesKey(deviceId), [family]);
    await sys.expire(deviceFamiliesKey(deviceId), DEVICE_FAMILIES_TTL_S);
  } catch {
    // best-effort
  }
}

/**
 * Sign-out: end the caller's family. When that family belongs to this browser's device record, also end every
 * other family signed in on it and forget its account list, so nothing signed in here survives. A device id the
 * caller's family is not part of is left alone.
 */
export async function endDeviceSessions(
  caller: SessionClaims | undefined,
  deviceId: string | undefined
): Promise<void> {
  const family = caller ? familyId(caller) : undefined;
  if (!family) return;
  await sessions.invalidateFamily(family).catch(() => undefined);

  const sys = getSysRedis();
  if (!sys || !deviceId) return;
  try {
    const members = (await sys.sMembers<unknown>(deviceFamiliesKey(deviceId))).map(String);
    if (!members.includes(family)) return;
    for (const other of members) {
      if (other !== family) await sessions.invalidateFamily(other);
    }
    await sys.del([deviceFamiliesKey(deviceId), deviceAccountsKey(deviceId)]);
  } catch {
    // best-effort: the caller's own family is already ended
  }
}
