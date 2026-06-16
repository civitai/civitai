import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeviceId, listAccounts, removeAccount } from '$lib/server/auth/device';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';

// GET /api/auth/accounts — the browser's linked-account list for the switcher menu. DISPLAY ONLY (no
// credentials leave the hub): resolves each linked userId to { username, image } from the shared session
// cache, marks the active one, and drops accounts idle >30d. Requires an active session. See cutover doc (E).
export const GET: RequestHandler = async ({ cookies, locals }) => {
  if (!locals.user) return json({ accounts: [] });
  const deviceId = getDeviceId(cookies);
  if (!deviceId) return json({ accounts: [] });

  const linked = await listAccounts(deviceId);
  const accounts = await Promise.all(
    linked.map(async ({ userId, lastSwitchedAt }) => {
      const account = await getOrProduceSessionUser(userId).catch(() => null);
      return {
        userId,
        username: account?.username,
        image: account?.image,
        lastSwitchedAt,
        active: locals.user?.id === userId,
      };
    })
  );
  return json({ accounts });
};

// DELETE /api/auth/accounts?userId=N — drop one account from THIS browser's device set ("remove from this
// browser"). Requires an active session; only affects the device cookie's own set. See cutover doc (E).
export const DELETE: RequestHandler = async ({ url, cookies, locals }) => {
  if (!locals.user) return json({ ok: false }, { status: 401 });
  const deviceId = getDeviceId(cookies);
  const userId = Number(url.searchParams.get('userId'));
  if (!deviceId || !Number.isFinite(userId)) return json({ ok: false }, { status: 400 });
  await removeAccount(deviceId, userId);
  return json({ ok: true });
};
