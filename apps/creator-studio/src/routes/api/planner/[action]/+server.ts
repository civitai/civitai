import { error, json } from '@sveltejs/kit';
import {
  isPlannerAction,
  isPlannerReadAction,
  PLANNER_READ_PARAMS,
} from '@civitai/post-planner/contract';
import type { RequestHandler } from './$types';
import { callPlanner, postPlannerEnabled, sessionCookies } from '$lib/server/post-planner';

/** Same-site pages share the session cookie, so a write must look like this app's own fetch: JSON,
 *  and same-origin when the browser says where it came from. SvelteKit's CSRF check covers form
 *  posts; this keeps the guarantee local to the route that needs it. */
function assertOwnWrite(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') error(403, 'Cross-site request refused');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
    error(415, 'Send this request as application/json');
}

async function gate(locals: App.Locals, action: string) {
  if (!isPlannerAction(action)) error(404, 'Not found');
  if (!(await postPlannerEnabled(locals.user))) error(404, 'Not found');
  return action;
}

export const GET: RequestHandler = async ({ locals, params, request, url }) => {
  const action = await gate(locals, params.action);
  if (!isPlannerReadAction(action)) error(405, 'Method not allowed');
  const query = new URLSearchParams();
  for (const key of PLANNER_READ_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) query.set(key, value);
  }
  const result = await callPlanner<unknown>(action, sessionCookies(request), {
    method: 'GET',
    query,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json(result.data);
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const action = await gate(locals, params.action);
  if (isPlannerReadAction(action)) error(405, 'Method not allowed');
  assertOwnWrite(request);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') error(400, 'Invalid request');
  const result = await callPlanner<unknown>(action, sessionCookies(request), {
    method: 'POST',
    body,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json(result.data);
};
