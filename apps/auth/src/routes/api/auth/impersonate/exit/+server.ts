import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mintUserSession } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';

// POST /api/auth/impersonate/exit — stop impersonating. No body, no extra auth: the authority is the
// `impersonatedBy` claim on the CURRENT session token (set only by a mod-authed impersonate call, so it's
// trustworthy). Re-mints the MODERATOR's own (non-impersonation) session and returns it; the caller sets the
// cookie. 400 when the current session isn't an impersonation session. See cutover doc (F).
export const POST: RequestHandler = async ({ locals }) => {
  const modId = locals.impersonatedBy;
  if (!modId) error(400, 'not an impersonation session');

  const moderator = await getOrProduceSessionUser(modId);
  if (!moderator) error(404, 'moderator not found');

  const token = await mintUserSession(moderator); // plain session — no impersonatedBy
  return json({ token, userId: moderator.id });
};
