import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeviceId, listAccounts } from '$lib/server/auth/device';
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
      const u = await getOrProduceSessionUser(userId).catch(() => null);
      return {
        userId,
        username: u?.username,
        image: u?.image,
        lastSwitchedAt,
        active: locals.user?.id === userId,
      };
    })
  );
  return json({ accounts });
};
