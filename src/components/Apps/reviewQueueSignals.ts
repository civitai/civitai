import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import type { ReviewPreviewState } from '~/server/services/blocks/publish-request.service';

/**
 * The DECISION SIGNALS a pending review row and the review page's Overview show: the review
 * preview's state, the agentic review's verdict (see `~/shared/utils/agent-review-verdict`) and
 * the count of sensitive permissions requested. Pure and React-free so the node tier pins the
 * mapping.
 *
 * 🔴 EVERY STATE RENDERS NOW, INCLUDING ONES NOTHING WRITES YET. `preview-queued` and
 * `preview-expired` are emitted by the auto-deploy work that lands separately; until it does,
 * a row simply never reaches them (and `expired` is also derived from a stale `preview-live`
 * server-side). Mapping them here means the chip is right the day they start arriving.
 */

export type PreviewChipState = 'none' | 'queued' | 'building' | 'live' | 'failed' | 'expired';

/** Map a pending request's `preview-*` lifecycle value to the chip state. */
export function previewChipState(
  state: ReviewPreviewState | string | null | undefined
): PreviewChipState {
  switch (state) {
    case 'preview-queued':
      return 'queued';
    case 'preview-building':
    case 'preview-deploying':
      return 'building';
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
