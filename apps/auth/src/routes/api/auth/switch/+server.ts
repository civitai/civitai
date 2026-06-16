import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeviceId, isLinkedAndFresh, touchAccount } from '$lib/server/auth/device';
import { mintUserSession } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { readUserId } from '$lib/server/auth/request';

// POST /api/auth/switch — DEVICE-LEVEL account switch. Authorized by BOTH (a) an ACTIVE session
// (locals.user — you can only switch while signed in) AND (b) the target being linked to THIS browser's
// device set and fresh (<30d). Mints a fresh civ-token for the target and RETURNS it — the caller (the main
// app's same-origin proxy) sets the `.civitai.com` cookie on its own response. Never trusts a client-held
// credential and never a User-to-User DB link. A target that's not linked / has aged out → 403 → re-login.
// See docs/main-app-auth-cutover.md (section E).
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
  return json({ token, userId });
};
