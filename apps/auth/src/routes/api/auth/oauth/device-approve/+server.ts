import { json, type RequestHandler } from '@sveltejs/kit';
import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '$lib/server/redis';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { resolvePendingDeviceCode, normalizeUserCode } from '$lib/server/oauth/device-codes';
import { parseBody } from '$lib/server/oauth/http';

// POST /api/auth/oauth/device-approve — session-gated approval of a device user_code. Marks the device
// code approved + stamps the approving user.
const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

export const POST: RequestHandler = async ({ request, getClientAddress, locals }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const { user_code } = await parseBody(request);
  if (!user_code) {
    return json({ error: 'invalid_request', error_description: 'Missing user_code' }, { status: 400 });
  }

  const resolved = await resolvePendingDeviceCode(user_code);
  if (!resolved.ok) {
    return json({ error: resolved.error, error_description: resolved.description }, { status: 400 });
  }
  const { deviceCode, data } = resolved;

  const redis = getRedis();
  if (!redis) return json({ error: 'invalid_code', error_description: 'Invalid or expired code' }, { status: 400 });

  // Mark approved + stamp the user. HSET drops the field's per-field TTL, so re-apply it to the code's
  // REMAINING lifetime — otherwise an approved-but-never-polled code would linger in the hash forever.
  // device-token also hDels on a successful poll.
  await redis.packed.hSet(DEVICE_CODE_KEY, deviceCode, { ...data, status: 'approved', userId: locals.user.id });
  const remainingMs = new Date(data.expiresAt).getTime() - Date.now();
  if (remainingMs > 0) await redis.hExpire(DEVICE_CODE_KEY, deviceCode, Math.ceil(remainingMs / 1000));
  await redis.hDel(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, normalizeUserCode(user_code));

  logOAuthEvent({
    type: 'authorization.granted',
    userId: locals.user.id,
    clientId: data.clientId,
    scope: parseInt(data.scope, 10),
    ip: getClientAddress(),
    metadata: { grant_type: 'device_code' },
  });

  return json({ success: true });
};
