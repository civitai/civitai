import { error } from '@sveltejs/kit';
import { requireAccess } from './access';

// `/api/*` is exempt from the global route gate in hooks.server.ts, so every endpoint carries its own
// check. Sharing it keeps the page path in one place: it is spelled as a literal, and `/retool/*` is a
// transitional namespace, so a path that moves would otherwise leave whichever copies were missed
// returning 403 forever — silently, since the panels only test `r.ok`.
export function requireUserIdParam(
  locals: App.Locals,
  params: { userId?: string },
  pagePath: string
): number {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, pagePath);

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0) error(400, 'Bad userId.');
  return userId;
}
