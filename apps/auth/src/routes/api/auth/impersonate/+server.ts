import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { mintUserSession, setSessionCookie } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { readUserId } from '$lib/server/auth/request';
import { trackImpersonation } from '$lib/server/auth/mod-activity';

// POST /api/auth/impersonate — moderator impersonation. The hub owns the WHOLE flow: the authorization gate, the
// mint (stamped `impersonatedBy = the moderator`), and the ModActivity audit. Callers (the main app's same-origin
// proxy, or a same-site spoke via the browser client) just set the returned cookie. Does NOT touch the device
// account-set (impersonation is not a linked account). See cutover doc (F).
//
// Gate mirrors the main app's `impersonation` feature flag: dev → any moderator (availability ['mod']); prod → a
// moderator who ALSO carries the granted `impersonation` permission (availability ['granted']). That permission
// lives in the produced session user's `permissions` (computed from SYSTEM.PERMISSIONS), so isModerator alone is
// NOT sufficient in prod — exactly the user's requirement.
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
  const mod = locals.user;
  if (!mod) error(401, 'unauthorized');

  const permitted = mod.isModerator && (dev || (mod.permissions ?? []).includes('impersonation'));
  if (!permitted) error(403, 'not permitted to impersonate');

  const userId = await readUserId(request);
  if (userId === mod.id) error(400, 'cannot impersonate self');

  const target = await getOrProduceSessionUser(userId);
  if (!target) error(404, 'no such user');

  const token = await mintUserSession(target, { impersonatedBy: mod.id });
  // Audit BEFORE returning — if it throws, no token ships, so an un-audited impersonation can never happen.
  await trackImpersonation(mod.id, userId, 'on');
  setSessionCookie(cookies, token); // direct browser-client path; NB: impersonation never touches the device set
  return json({ token, userId });
};
