import type { WorkflowSource } from '$lib/server/user-workflows.service';

export type UserWorkflowsRequest = { kind: 'ids'; url: string } | { kind: 'page'; url: string };

/**
 * Which read the generations panel makes. 🔴 A present `workflowIds` — even `''` or all junk — is a
 * narrowed view and must never fall through to the account's paged history.
 */
export function userWorkflowsRequest(
  userId: number,
  {
    workflowIds,
    source,
    cursor,
  }: { workflowIds: string | null; source: WorkflowSource; cursor: string }
): UserWorkflowsRequest {
  if (workflowIds !== null)
    return {
      kind: 'ids',
      url: `/api/user-workflows/${userId}?ids=${encodeURIComponent(workflowIds)}`,
    };
  return {
    kind: 'page',
    url: `/api/user-workflows/${userId}?take=20&source=${source}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    }`,
  };
}

/** Every `workflows=` value on a URL, joined, or null when there is none: a repeated param must not
 *  silently lose its later values. */
export const workflowIdsParam = (params: URLSearchParams): string | null => {
  const all = params.getAll('workflows');
  return all.length ? all.join(',') : null;
};
