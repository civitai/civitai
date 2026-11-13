import type { DatasetItemState, WorkflowOrigin } from '$lib/server/training-moderation.service';

/** Shared by the queue and the review page so a run is described the same way on both. The tags this
 *  reads are written by the submitter, so it is a label, never a decision. */
export function workflowOriginLabel(origin: WorkflowOrigin | null): string {
  if (!origin) return 'Unknown (not checked)';
  if (origin.kind === 'app-block') return `App Block · ${origin.appId}`;
  if (origin.kind === 'studio') return 'Training Studio';
  return 'Other';
}

/** Under this much time left, the gate is flagged as about to expire (and refund the run). */
const EXPIRY_WARNING_MS = 6 * 3_600_000;

export const gateExpiresSoon = (expiresAt: string | null, now = Date.now()): boolean =>
  !!expiresAt && Date.parse(expiresAt) - now < EXPIRY_WARNING_MS;

/**
 * Whether a moderator can actually see at least one item of the dataset, judged by what the items
 * PROBED as — not by their shape: a dataset of stored items that are all blocked or unserved shows
 * nothing. Decides whether Approve needs an explicit "reviewed it another way". The page asks from its
 * probe; the server refuses from its own probe at approve time (`anyItemViewable`, which stops at the
 * first viewable item), never from anything the page posts. Both read `viewable` the same way —
 * `isViewableProbe` in the service.
 */
export const hasViewableItem = (states: Record<number, DatasetItemState>): boolean =>
  Object.values(states).includes('viewable');
