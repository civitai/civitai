// The planner's REST wire contract, shared by the main app's route, the Creator Studio proxy and
// every host that talks to it over HTTP. The tRPC procedures behind it are the source of truth for
// validation; this is only their names, methods, and shapes as they cross the wire.

import type {
  MoveResult,
  PlannerBackend,
  PlannerPostDetail,
  PlannerScope,
  ScheduledRange,
  ShiftResult,
  UnscheduleResult,
} from './host.js';

export const PLANNER_REST_PATH = '/api/v1/posts/planner';

export const PLANNER_ACTIONS = {
  scheduled: { method: 'GET' },
  detail: { method: 'GET' },
  schedule: { method: 'POST' },
  unschedule: { method: 'POST' },
  shift: { method: 'POST' },
} as const satisfies Record<string, { method: 'GET' | 'POST' }>;

export type PlannerAction = keyof typeof PLANNER_ACTIONS;
export type PlannerActionMethod<A extends PlannerAction> = (typeof PLANNER_ACTIONS)[A]['method'];
export type PlannerReadAction = {
  [A in PlannerAction]: PlannerActionMethod<A> extends 'GET' ? A : never;
}[PlannerAction];
export type PlannerWriteAction = Exclude<PlannerAction, PlannerReadAction>;

export function isPlannerAction(value: string): value is PlannerAction {
  return Object.prototype.hasOwnProperty.call(PLANNER_ACTIONS, value);
}

export function isPlannerReadAction(action: PlannerAction): action is PlannerReadAction {
  return PLANNER_ACTIONS[action].method === 'GET';
}

/** Everything a read accepts on the query string; a proxy forwards nothing else. */
export const PLANNER_READ_PARAMS = ['from', 'to', 'modelVersionId', 'id'] as const;

export interface PlannerRequests {
  scheduled: Parameters<PlannerBackend['getScheduled']>[0];
  detail: { id: number };
  schedule:
    | Parameters<PlannerBackend['reschedule']>[0]
    | (Parameters<PlannerBackend['publishNow']>[0] & { publishNow: true });
  unschedule: { ids: number[] };
  shift: Parameters<PlannerBackend['shift']>[0];
}

export interface PlannerResponses {
  scheduled: ScheduledRange;
  detail: PlannerPostDetail;
  schedule: MoveResult;
  unschedule: UnscheduleResult;
  shift: ShiftResult;
}

/** A refusal keeps the server's message so the UI can show it; `code` is the tRPC error code. */
export interface PlannerErrorBody {
  error: string;
  code?: string;
}

export type { PlannerScope };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function plannerRequest<A extends PlannerAction>(
  baseUrl: string,
  action: A,
  input: PlannerRequests[A]
): { url: string; init: RequestInit } {
  const method = PLANNER_ACTIONS[action].method;
  if (method === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value));
    return { url: `${baseUrl}/${action}?${query}`, init: { method } };
  }
  return {
    url: `${baseUrl}/${action}`,
    init: { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
  };
}

/**
 * A `PlannerBackend` over the REST contract at `baseUrl` — the main app's `PLANNER_REST_PATH`, or a
 * proxy that forwards to it unchanged. A failed response rejects with the server's message.
 */
export function createPlannerBackend(
  baseUrl: string,
  fetchLike: FetchLike = (input, init) => fetch(input, init)
): PlannerBackend {
  async function call<A extends PlannerAction>(
    action: A,
    input: PlannerRequests[A]
  ): Promise<PlannerResponses[A]> {
    const { url, init } = plannerRequest(baseUrl, action, input);
    const res = await fetchLike(url, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | (Partial<PlannerErrorBody> & { message?: string })
        | null;
      throw new Error(body?.error ?? body?.message ?? `Request failed (${res.status}).`);
    }
    return (await res.json()) as PlannerResponses[A];
  }

  return {
    getScheduled: (range) => call('scheduled', range),
    getPostDetail: (id) => call('detail', { id }),
    reschedule: (req) => call('schedule', req),
    publishNow: (req) => call('schedule', { ...req, publishNow: true }),
    unschedule: (ids) => call('unschedule', { ids }),
    shift: (req) => call('shift', req),
  };
}
