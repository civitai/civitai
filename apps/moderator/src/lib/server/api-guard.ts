import { error } from '@sveltejs/kit';
import { requireAccess } from './access';

// `/api/*` is exempt from the global route gate in hooks.server.ts, so every endpoint carries its own
// check. Sharing it keeps the page path in one place: it is spelled as a literal, and `/retool/*` is a
// transitional namespace, so a path that moves would otherwise leave whichever copies were missed
// returning 403 forever — silently, since the panels only test `r.ok`.
//
// The bounds check is not only validation. These ids are interpolated into ClickHouse queries by the
// services, and that helper does NO escaping; the upper bound also keeps an over-long paste from erroring
// a Postgres `integer` comparison instead of missing cleanly.
const MAX_INT = 2_147_483_647;

export function requireIdParam(
  locals: App.Locals,
  raw: string | undefined,
  pagePath: string,
  name: string
): number {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, pagePath);

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > MAX_INT) error(400, `Bad ${name}.`);
  return id;
}

export const requireUserIdParam = (
  locals: App.Locals,
  params: { userId?: string },
  pagePath: string
) => requireIdParam(locals, params.userId, pagePath, 'userId');
