import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
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

// ─── Script-facing helpers ────────────────────────────────────────────────────────────────────────
// The helpers above serve the app's own panels, fetched by a signed-in browser. The ones below serve
// callers that are not a browser, so they answer in JSON. Their AUTH is not here: token-guarded prefixes
// are authenticated in hooks.server.ts ($lib/server/token-auth), so an endpoint cannot publish itself by
// forgetting a check.

/** Describes one endpoint for `/xguard/docs`. Read off the module itself so the page cannot drift from the API. */
export type EndpointDoc = {
  summary: string;
  /** Query-string or JSON-body params, in the order a caller cares about. */
  params?: { name: string; type: string; required?: boolean; description: string }[];
  /** What comes back, in a sentence. */
  returns?: string;
  notes?: string[];
};

/** Parse a JSON request body, turning a malformed one into a 400 rather than a 500. */
export async function readJson<T>(event: RequestEvent): Promise<T> {
  try {
    return (await event.request.json()) as T;
  } catch {
    return error(400, 'Request body must be JSON.');
  }
}

export function ok<T>(body: T, status = 200): Response {
  return json(body as unknown as Record<string, unknown>, { status });
}

/**
 * Read a bounded integer out of a query string. Out-of-range is clamped rather than rejected, but junk
 * (`limit=all`) is an error — silently treating it as the default would hide a broken caller loop.
 */
export function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) error(400, `${name} must be a number`);
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
