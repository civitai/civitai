import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';
import { canAccess, requireAccess } from './access';

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

// ─── Script-facing endpoints ──────────────────────────────────────────────────────────────────────
// The helpers above serve the app's own panels, fetched by a signed-in browser. The ones below serve
// callers that are not a browser, so they answer in JSON.
//
// A request carrying NO credentials at all never reaches here: it has no bearer, so the hook falls
// through to the cookie guard and is redirected to the hub login. For a script that 302 is a 200 with
// HTML attached, which is the failure mode this file otherwise avoids — open question for review,
// since answering 401 there would change the existing `/api/*` routes too.

export type ApiActor = { user: SessionUser; viaApiKey: boolean };

/**
 * @param pagePath the page whose access this endpoint borrows — `/xguard` for everything in the lab.
 *                 Endpoints do not get their own grant; one reachable by someone who cannot open the
 *                 corresponding page is a permission fork waiting to drift.
 */
export function requireApiAccess(event: RequestEvent, pagePath: string): ApiActor {
  const user = event.locals.user;
  if (!user) error(401, 'Send a Civitai API key as `Authorization: Bearer <key>`, or sign in.');
  if (!canAccess(user, pagePath)) error(403, `Your account does not have access to ${pagePath}.`);
  return { user, viaApiKey: event.locals.viaApiKey === true };
}

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
