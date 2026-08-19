import { error, json } from '@sveltejs/kit';
import { canAccess } from './access';

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
  /** One page, or several — an endpoint serving two pages that are granted separately must accept
   *  either, and gating on one silently refuses the other's holders. */
  pagePath: string | string[],
  name: string
): number {
  if (!locals.user) error(403, 'Not signed in.');
  const paths = Array.isArray(pagePath) ? pagePath : [pagePath];
  if (!paths.some((path) => canAccess(locals.user!, path)))
    error(403, 'You do not have access to this page.');

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > MAX_INT) error(400, `Bad ${name}.`);
  return id;
}

export const requireUserIdParam = (
  locals: App.Locals,
  params: { userId?: string },
  pagePath: string
) => requireIdParam(locals, params.userId, pagePath, 'userId');

// ─── Script-facing helpers ────────────────────────────────────────────────────────────────────────
// The helpers above serve the app's own panels, fetched by a signed-in browser. The ones below serve
// callers that are not a browser. New endpoints should use $lib/server/api-endpoint, which authenticates
// them and derives this doc shape from the schema rather than restating it.

/** The rendered shape of an endpoint's docs. Built from a schema by `specToDoc`. */
export type EndpointDoc = {
  summary: string;
  /** Query-string or JSON-body params, in the order a caller cares about. */
  params?: { name: string; type: string; required?: boolean; description: string }[];
  /** What comes back, in a sentence. */
  returns?: string;
  notes?: string[];
};

export function ok<T>(body: T, status = 200): Response {
  return json(body as unknown as Record<string, unknown>, { status });
}
