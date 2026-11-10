import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canSwitch, isLinkedAndFresh, listAccounts, removeAccount } from '$lib/server/auth/device';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';

// GET /api/auth/accounts — the browser's linked-account list for the switcher menu. DISPLAY ONLY (no
// credentials leave the hub): resolves each linked userId to { username, image } from the shared session
// cache, marks the active one, and drops accounts idle >30d. See cutover doc (E).
// Convention: route failures throw `error(status)`, BUT this is a display endpoint, so "not signed in / no
// device" returns an empty list (200) rather than a 401 — the switcher just shows nothing. The set is listed
// only when the caller's principal (the impersonating moderator, else the active account) is linked and fresh
// on this device, the same membership rule as /api/auth/switch.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({ accounts: [] });
  const deviceId = locals.deviceId;
  if (!deviceId) return json({ accounts: [] });
  const principal = locals.impersonatedBy ?? locals.user.id;
  if (!(await isLinkedAndFresh(deviceId, principal))) return json({ accounts: [] });

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

// POST lists too: it is the form a service caller uses, since the session travels in the body and a GET has none.
export const POST: RequestHandler = GET;

// DELETE /api/auth/accounts?userId=N — drop one account from THIS browser's device set ("remove from this
// browser"), under the same membership rule as /api/auth/switch; removing yourself needs only your own
// membership. See cutover doc (E).

export const DELETE: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) error(401, 'active session required');
  const deviceId = locals.deviceId;
  const userId = Number(url.searchParams.get('userId'));
  if (!deviceId || !Number.isFinite(userId)) error(400, 'bad request');
  const principal = locals.impersonatedBy ?? locals.user.id;
  if (!(await canSwitch(deviceId, principal, userId))) error(403, 'account not linked or expired');
  await removeAccount(deviceId, userId);
  return json({ ok: true });
};
