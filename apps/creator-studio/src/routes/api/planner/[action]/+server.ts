import { error, json } from '@sveltejs/kit';
import {
  isPlannerAction,
  isPlannerReadAction,
  PLANNER_READ_PARAMS,
} from '@civitai/post-planner/contract';
import type { RequestHandler } from './$types';
import { callPlanner, postPlannerEnabled } from '$lib/server/post-planner';
import { sessionCookies } from '$lib/server/session-cookies';
import { assertOwnWrite } from '$lib/server/own-write';

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
