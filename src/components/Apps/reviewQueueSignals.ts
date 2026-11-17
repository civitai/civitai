import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import {
  isReviewPreviewBuilding,
  type ReviewPreviewState,
} from '~/shared/constants/app-review-preview.constants';

/**
 * The DECISION SIGNALS a pending review row and the review page's Overview show: the review
 * preview's state, the agentic review's finding counts (see `~/shared/utils/agent-review-findings`) and
 * the count of sensitive permissions requested. Pure and React-free so the node tier pins the
 * mapping.
 *
 * The states are the shared ones (`~/shared/constants/app-review-preview.constants`): the
 * server stores `preview-queued` … `preview-failed` and REPORTS `preview-expired` past the
 * preview's maximum age (`reportedReviewPreviewState`, the same rule the review page reads).
 */

export type PreviewChipState = 'none' | 'queued' | 'building' | 'live' | 'failed' | 'expired';

/** Map a pending request's `preview-*` lifecycle value to the chip state. */
export function previewChipState(
  state: ReviewPreviewState | string | null | undefined
): PreviewChipState {
  if (isReviewPreviewBuilding(state)) return 'building';
  switch (state) {
    case 'preview-queued':
      return 'queued';
    case 'preview-live':
      return 'live';
    case 'preview-failed':
      return 'failed';
    case 'preview-expired':
      return 'expired';
    default:
      return 'none';
  }
}

export const PREVIEW_CHIP_LABELS: Record<PreviewChipState, string> = {
  none: 'Preview: not started',
  queued: 'Preview: queued',
  building: 'Preview: building',
  live: 'Preview: live',
  failed: 'Preview: failed',
  expired: 'Preview: expired',
};

export const PREVIEW_CHIP_COLORS: Record<PreviewChipState, string> = {
  none: 'gray',
  queued: 'gray',
  building: 'blue',
  live: 'green',
  failed: 'red',
  expired: 'orange',
};

/** The declared scopes of a manifest, strings only (a malformed manifest yields none). */
export function manifestScopes(manifest: unknown): string[] {
  const scopes = (manifest as { scopes?: unknown } | null | undefined)?.scopes;
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [];
}

/** How many SENSITIVE permissions the manifest requests (same predicate as the Permissions tab). */
export function sensitiveScopeCount(manifest: unknown): number {
  return manifestScopes(manifest).filter((s) => isSensitiveBlockScope(s)).length;
}

export function sensitiveChipLabel(count: number): string {
  return count === 0 ? 'No sensitive perms' : `${count} sensitive perm${count === 1 ? '' : 's'}`;
}
