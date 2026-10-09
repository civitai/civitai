import { constants } from '~/server/common/constants';

/**
 * Who asked the storage resolver for a URL, sent with every `/resolve` request so
 * resolves can be attributed to the code path that caused them.
 *
 * Every call site of `resolveDownloadUrl` names its own `caller` explicitly; the
 * ledger in `src/utils/__tests__/resolve-caller-seam.test.ts` fails when a call
 * site is added, removed or re-pointed. A new path that fits none of these takes
 * `other` rather than borrowing a neighbour's name.
 */
export const RESOLVE_CALLERS = [
  'download-route',
  'vault',
  'link',
  'internal-presigned',
  'orchestrator-preflight',
  'training-data',
  'model3d',
  'wildcard',
  'other',
] as const;
export type ResolveCaller = (typeof RESOLVE_CALLERS)[number];

export const RESOLVE_ACTORS = ['user', 'anon', 'internal'] as const;
export type ResolveActor = (typeof RESOLVE_ACTORS)[number];

export type ResolveAttribution = {
  caller: ResolveCaller;
  actor: ResolveActor;
};

/**
 * Classify the identity behind a request-scoped resolve.
 *
 * Internal services (the file scanner among them) authenticate as the system
 * account, `constants.system.user.id`, so a session carrying that id is
 * `internal` rather than a user. No session at all is `anon`.
 *
 * Call sites with no request context (jobs, server-side fetches) do not call
 * this; they pass `internal` directly.
 *
 * Known gap: `internal` covers only internal callers that present the system
 * account's credential. A worker that is handed a download URL WITHOUT a token
 * (e.g. one run by a provider the orchestrator does not authorize) arrives with
 * no session, so it is classified `anon` and cannot be told apart from an
 * anonymous visitor here. Distinguishing it needs a signal on the request
 * itself, which this function does not have.
 */
export function resolveActorFor(user: { id?: number } | null | undefined): ResolveActor {
  if (user?.id == null) return 'anon';
  if (user.id === constants.system.user.id) return 'internal';
  return 'user';
}
