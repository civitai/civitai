import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mintUserSession, setSessionCookie } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { trackImpersonation } from '$lib/server/auth/mod-activity';

// POST /api/auth/impersonate/exit — stop impersonating. No body, no extra auth: the authority is the
// `impersonatedBy` claim on the CURRENT session token (set only by a mod-authed impersonate call, so it's
// trustworthy). Re-mints the MODERATOR's own (non-impersonation) session, writes the matching ModActivity
// 'off' audit, and returns the token; the caller sets the cookie. 400 when the current session isn't an
// impersonation session. See cutover doc (F).
export const POST: RequestHandler = async ({ cookies, locals }) => {
  const modId = locals.impersonatedBy;
  if (!modId) error(400, 'not an impersonation session');
  const targetId = locals.user?.id; // the user being impersonated (the current session's subject)

  const moderator = await getOrProduceSessionUser(modId);
  if (!moderator) error(404, 'moderator not found');

  const token = await mintUserSession(moderator); // plain session — no impersonatedBy
  if (targetId) await trackImpersonation(modId, targetId, 'off');
  setSessionCookie(cookies, token); // direct browser-client path: hub re-lands the moderator's own cookie
  return json({ token, userId: moderator.id });
};
