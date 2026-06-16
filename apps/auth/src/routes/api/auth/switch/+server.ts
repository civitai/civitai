import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeviceId, isLinkedAndFresh, rollDeviceCookie, touchAccount } from '$lib/server/auth/device';
import { mintUserSession, setSessionCookie } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { readUserId } from '$lib/server/auth/request';

// POST /api/auth/switch — DEVICE-LEVEL account switch. Authorized by BOTH (a) an ACTIVE session
// (locals.user — you can only switch while signed in) AND (b) the target being linked to THIS browser's
// device set and fresh (<30d). Mints a fresh civ-token for the target. The hub SETS the `.civitai.com` cookie
// itself (+ rolls the device cookie) for same-site spokes using the browser client directly, AND returns the
// token so the main app's cross-site `.red` proxy can set its own. Never trusts a client-held credential and
// never a User-to-User DB link. A target that's not linked / has aged out → 403 → re-login. See cutover doc (E).
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
  if (!locals.user) error(401, 'active session required');
  const deviceId = getDeviceId(cookies);
  if (!deviceId) error(401, 'no device');

  const userId = await readUserId(request);

  // The whole authorization: is this account linked to THIS device and not idle-expired?
  if (!(await isLinkedAndFresh(deviceId, userId))) error(403, 'account not linked or expired');

  const user = await getOrProduceSessionUser(userId);
  if (!user) error(404, 'no such user');

  const token = await mintUserSession(user);
  await touchAccount(deviceId, userId); // slide the 30-day idle clock
  setSessionCookie(cookies, token); // direct browser-client path: hub lands the cookie itself
  rollDeviceCookie(cookies, deviceId); // keep the device cookie alive in lockstep with its redis set
  return json({ token, userId });
};
