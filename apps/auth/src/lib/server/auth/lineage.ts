import { familyId, type SessionClaims } from '@civitai/auth';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { evalSys, getSysRedis } from '../redis';
import { sessions } from './registry';

// A family is every session descended from one sign-in on one browser (see @civitai/auth `familyClaims`).
// These records let the hub tell a family is still in use, and end every family a browser signed in with.

const DAY_S = 24 * 60 * 60;
const FAMILY_LIVE_TTL_MS = 30 * DAY_S * 1000;
// Outlasts the 90-day session limit, so a family's membership can't lapse while its sessions are accepted.
const DEVICE_FAMILIES_TTL_S = 91 * DAY_S;

const deviceFamiliesKey = (deviceId: string) =>
  `${REDIS_SYS_KEYS.SESSION.DEVICE_FAMILIES}:${deviceId}` as const;
const deviceAccountsKey = (deviceId: string) =>
  `${REDIS_SYS_KEYS.DEVICE.ACCOUNTS}:${deviceId}` as const;

const MARK_LIVE_SCRIPT = `
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('HPEXPIRE', KEYS[1], ARGV[3], 'FIELDS', '1', ARGV[1])
  return 1
`;

/** Record that `family` was just used. Best-effort. */
export async function markFamilyLive(family: string | undefined): Promise<void> {
  if (!family) return;
  await evalSys(
    MARK_LIVE_SCRIPT,
    [REDIS_SYS_KEYS.SESSION.FAMILY_LIVE],
    [family, String(Date.now()), String(FAMILY_LIVE_TTL_MS)]
  ).catch(() => undefined);
}

// A browser's family record is joined only with proof that the browser is signed in to it: a family already in
// it (the browser's prior hub session), or `ARGV[3] == '1'` when the caller already proved it another way.
// 0: created; 1: joined; -1: refused.
const ADD_FAMILY_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return 0
  end
  if ARGV[3] == '1' or redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1
    or (ARGV[2] ~= '' and redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1) then
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return 1
  end
  return -1
`;

/**
 * Remember that `family` signed in on this browser, so signing out here ends it too. `proofFamily` is the family
 * of the verified hub session the same request carries. Returns `'rotate'` when the browser has a record this
 * request can't show it belongs to: the caller moves the browser to a new device id. Best-effort.
 */
export async function addDeviceFamily(
  deviceId: string | undefined,
  family: string | undefined,
  opts: { proofFamily?: string; proven?: boolean } = {}
): Promise<'added' | 'rotate'> {
  if (!deviceId || !family) return 'added';
  try {
    const result = await evalSys(
      ADD_FAMILY_SCRIPT,
      [deviceFamiliesKey(deviceId)],
      [family, opts.proofFamily ?? '', opts.proven ? '1' : '0', String(DEVICE_FAMILIES_TTL_S)]
    );
    return Number(result) === -1 ? 'rotate' : 'added';
  } catch {
    return 'added';
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
  let members: string[];
  try {
    members = (await sys.sMembers<unknown>(deviceFamiliesKey(deviceId))).map(String);
  } catch {
    return;
  }
  if (!members.includes(family)) return;
  try {
    for (const other of members) {
      if (other !== family) await sessions.invalidateFamily(other).catch(() => undefined);
    }
  } finally {
    await sys
      .del([deviceFamiliesKey(deviceId), deviceAccountsKey(deviceId)])
      .catch(() => undefined);
  }
}
