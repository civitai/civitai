import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mintUserSession } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { trackImpersonation } from '$lib/server/auth/mod-activity';
import { sessions } from '$lib/server/auth/registry';

// POST /api/auth/impersonate/exit — stop impersonating. No body, no extra auth: the authority is the
// `impersonatedBy` claim on the CURRENT session token (set only by a mod-authed impersonate call, so it's
// trustworthy). Re-mints the MODERATOR's own (non-impersonation) session, writes the matching ModActivity
// 'off' audit, and returns the token; the caller sets the cookie. 400 when the current session isn't an
// impersonation session. See cutover doc (F).
export const POST: RequestHandler = async ({ locals }) => {
  const modId = locals.impersonatedBy;
  if (!modId) error(400, 'not an impersonation session');
  const targetId = locals.user?.id; // the user being impersonated (the current session's subject)

  const moderator = await getOrProduceSessionUser(modId);
  // A deleted moderator isn't produced at all. Either way, cut every session they hold or impersonate.
  if (!moderator || moderator.bannedAt) {
    await sessions.invalidateUserSessions(modId);
    // 410, not 403: every session involved has ended, which the caller treats as signed out.
    error(410, 'moderator account is not active');
  }

  const token = await mintUserSession(moderator, {
    parent: locals.session,
    clearImpersonation: true,
  });
  if (targetId) await trackImpersonation(modId, targetId, 'off');
  return json({ token, userId: moderator.id });
};
