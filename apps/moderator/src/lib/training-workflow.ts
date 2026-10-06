import type { WorkflowOrigin } from '$lib/server/training-moderation.service';

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
