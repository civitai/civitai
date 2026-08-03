import { useRef } from 'react';
import { pickReviewIframeSrc } from '~/components/Apps/reviewIframeSrc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * MOD REVIEW SANDBOX (#2831) — shared live-preview poll + iframe-src stabilization
 * for the review host bridge.
 *
 * Extracted VERBATIM from `ReviewPreviewPanel` (OnsiteReviewModal.tsx) so the
 * in-modal 420px preview and the new full-page preview route
 * (`/apps/review/preview/<publishRequestId>`) share ONE source of truth for the
 * poll cadence + token-swap stabilization. The behaviour here is byte-for-byte
 * the panel's prior inline logic — do not change the poll intervals or the
 * `pickReviewIframeSrc` wiring without updating both callers.
 *
 * Poll the review status. Enabled on mount (not gated on a client "started" flag)
 * so a preview already live on the row is picked up after a page reload / modal
 * re-open — getReviewStatus returns the PERSISTED deploy_state, so callers derive
 * the button + live host from the server, not from ephemeral React state.
 * building/deploying poll fast, live polls slow, none/failed do a single fetch
 * then stop (see refetchInterval).
 */
export function useReviewPreview(publishRequestId: string) {
  const features = useFeatureFlags();

  const statusQuery = trpc.blocks.getReviewStatus.useQuery(
    { publishRequestId },
    {
      enabled: !!features?.appBlocks,
      retry: false,
      refetchInterval: (query) => {
        // react-query v5: the callback receives the Query; the data is at
        // query.state.data (matches the my-submissions.tsx idiom).
        const s = query.state.data?.state;
        if (s === 'preview-building' || s === 'preview-deploying') return 3000;
        // Keep a SLOW poll alive while the preview is live — it detects
        // approve/reject/teardown state changes. getReviewStatus mints a fresh
        // `?mr=<token>` previewUrl (120s TTL) on every poll, but the IFRAME src is
        // DECOUPLED from the poll via pickReviewIframeSrc (see `stableIframeSrc`
        // below): the iframe keeps its src until the embedded token nears expiry,
        // then swaps ONCE — so the live preview doesn't hard-reload every minute
        // (which would wipe in-progress interaction). A 60s poll < 120s TTL still
        // guarantees a fresh token is always available when a swap is due.
        if (s === 'preview-live') return 60000;
        return false; // failed or none → stop polling
      },
    }
  );

  const state = statusQuery.data?.state ?? null;
  const detail = statusQuery.data?.detail;
  // Prefer the FRESH, mod-bound, short-TTL tokened URL (`?mr=<token>`) the server
  // mints on every poll when the preview is live — that token is the cross-origin
  // access bridge the `*.civit.ai` mod-gate forwardAuth verifies on the iframe's
  // entry document request. Read from the latest query data each render so the
  // iframe never mounts with an expired token. Fall back to the bare host URL
  // (e.g. while building) only for stabilization input.
  const url = statusQuery.data?.previewUrl ?? detail?.url;
  const inProgress = state === 'preview-building' || state === 'preview-deploying';
  const isLive = state === 'preview-live';
  const isFailed = state === 'preview-failed';

  // Stabilize the IFRAME src so it does NOT change on every poll. getReviewStatus
  // mints a fresh `?mr=<token>` previewUrl every 60s poll; binding the iframe
  // straight to `url` would hard-reload it each minute, wiping in-progress
  // interaction in the previewed block. pickReviewIframeSrc keeps the embedded
  // src until its token nears expiry (TTL 120s), then swaps once. Held in a ref so
  // the chosen src survives re-renders; recomputed each render via the pure helper.
  const iframeSrcRef = useRef<string | undefined>(undefined);
  const stableIframeSrc = isLive
    ? pickReviewIframeSrc(iframeSrcRef.current, url, Date.now())
    : undefined;
  // Persist the choice so the next render compares against the embedded token,
  // not the latest poll's. Clear when the preview leaves the live state.
  iframeSrcRef.current = stableIframeSrc || undefined;

  return {
    state,
    detail,
    isLive,
    inProgress,
    isFailed,
    stableIframeSrc,
    error: statusQuery.error,
  };
}
