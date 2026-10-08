import type { SessionUser } from '@civitai/auth';
import { PLANNER_REST_PATH, type PlannerAction } from '@civitai/post-planner/contract';
import { POST_PLANNER_FLAG } from '$lib/nav';
import { callMainApp, type MainAppResult } from '$lib/server/main-app';
import { modFallbackFlagEnabled } from '$lib/server/main-app-flags';

export function postPlannerEnabled(user: SessionUser): Promise<boolean> {
  return modFallbackFlagEnabled(POST_PLANNER_FLAG, user);
}

// Every planner read and write is owned by the main app (ownership, release fan-out, reindex, the
// guards on publishing). This app only forwards the creator's session cookie to the REST twin.
export function callPlanner<T>(
  action: PlannerAction,
  cookie: string,
  init: { method: 'GET'; query: URLSearchParams } | { method: 'POST'; body: unknown }
): Promise<MainAppResult<T>> {
  const path =
    init.method === 'GET'
      ? `${PLANNER_REST_PATH}/${action}?${init.query.toString()}`
      : `${PLANNER_REST_PATH}/${action}`;
  return callMainApp<T>(path, cookie, {
    method: init.method,
    body: init.method === 'POST' ? init.body : undefined,
    timeoutMs: 30_000,
  });
}

/** Only the hub's session cookies cross to the main app; this app's own test-simulator cookies stay here. */
export function sessionCookies(request: Request): string {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('civ-'))
    .join('; ');
}
