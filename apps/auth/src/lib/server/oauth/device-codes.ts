import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '$lib/server/redis';

// Shared device-flow code resolution for the session-gated verify endpoints (device-info + device-approve).
// Both did the identical 2-step lookup (user_code → deviceCode → record) with the same guards; this is the
// single source for that, plus user_code normalization.

export interface DeviceCodeData {
  clientId: string;
  userCode: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied';
  userId: number | null;
  expiresAt: string;
}

/**
 * Canonicalize a user-entered code to the stored `XXXX-XXXX` form: upper-case, drop anything that isn't
 * alphanumeric (spaces, stray punctuation), and re-insert the hyphen for an 8-char code. So `abcd1234`,
 * `ABCD 1234`, and `abcd-1234` all resolve. Non-8-char input falls back to a plain upper-case.
 */
export function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : raw.toUpperCase();
}

/**
 * Resolve a user_code → its PENDING device-code record. Returns `{ deviceCode, data }` when the code maps
 * to a still-pending entry, else `{ error }` describing why (mirrors the endpoints' prior error shapes).
 */
export async function resolvePendingDeviceCode(
  userCode: string
): Promise<
  | { ok: true; deviceCode: string; data: DeviceCodeData }
  | { ok: false; error: string; description: string }
> {
  const redis = getRedis();
  if (!redis) return { ok: false, error: 'invalid_code', description: 'Invalid or expired code' };

  const deviceCode = await redis.packed.hGet<string>(
    REDIS_KEYS.OAUTH.DEVICE_USER_CODES,
    normalizeUserCode(userCode)
  );
  if (!deviceCode) return { ok: false, error: 'invalid_code', description: 'Invalid or expired code' };

  const data = await redis.packed.hGet<DeviceCodeData>(REDIS_KEYS.OAUTH.DEVICE_CODES, deviceCode);
  if (!data || data.status !== 'pending') {
    return { ok: false, error: 'invalid_code', description: 'Code already used or expired' };
  }
  return { ok: true, deviceCode, data };
}
