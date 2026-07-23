import { useCallback, useEffect, useRef, useState } from 'react';
import { OnsiteReviewModalBody, type OnsiteReviewSelection } from '~/components/Apps/OnsiteReviewModal';
import {
  ReviewActionBar,
  type ReviewActionStatus,
} from '~/components/Apps/ReviewActionBar';
import { useReviewNavigationGuard } from '~/components/Apps/useReviewNavigationGuard';

/**
 * The per-submission review PAGE body (`/apps/review/<id>`), factored OUT of the
 * page module so it carries no `getServerSideProps`/server graph and is browser-
 * testable (same reason `OnsiteReviewModalBody` was extracted from the modal).
 *
 * It re-hosts the shared review body WITHOUT the modal footer (`hideInlineActions`)
 * and instead pins the approve/reject controls in a sticky bottom `ReviewActionBar`
 * so a mod never has to scroll the long tabbed report to act. Adds the a11y layer a
 * page needs but a focus-trapping modal did not:
 *  - focus moves to the main review region on mount (not left on `<body>`);
 *  - an `aria-live="polite"` region announces mutation-status transitions;
 *  - a route-leave guard blocks navigation while an approve/reject is in flight
 *    (the page analogue of the modal's `busyRef` close-refusal).
 *
 * `selection` is already resolved by the page (SSR gate + client `getPublishRequest`
 * fetch); this component is purely presentational + interaction.
 */

const STATUS_MESSAGE: Record<ReviewActionStatus, string> = {
  idle: '',
  submitting: 'Submitting the review decision…',
  approved: 'Submission approved. Returning to the review queue.',
  rejected: 'Submission rejected. Returning to the review queue.',
  error: 'The review action failed. Please try again.',
};

export function ReviewDetailView({
  selection,
  onClose,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
  onClose: () => void;
}) {
  const mainRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ReviewActionStatus>('idle');

  // Block navigation (link click / back button / tab close) while an approve or
  // reject mutation is running — the page's replacement for the modal's busyRef
  // close-guard. Returns a `bypass()` we trip synchronously before the intended
  // success-redirect so the guard never blocks its own `router.push`.
  const bypassGuard = useReviewNavigationGuard(status === 'submitting');

  // The action bar calls this after a successful approve/reject. Trip the guard's
  // bypass SYNCHRONOUSLY (before the redirect fires in `onClose`) so the guard —
  // which is still armed at this instant, since its disarm is a scheduled
  // effect-cleanup — lets THIS navigation through instead of aborting it.
  const handleActionSuccess = useCallback(() => {
    bypassGuard();
    onClose();
  }, [bypassGuard, onClose]);

  // A page has no focus trap, so a screen-reader/keyboard user would otherwise be
  // stranded on <body> after the route change. Move focus to the main region once.
  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  return (
    <>
      {/* Polite status announcements (submitting / approved / rejected / error). A
          modal never needed this — a page transition does. Kept visually hidden. */}
      <div
        aria-live="polite"
        role="status"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
        data-testid="apps-review-status-live"
      >
        {STATUS_MESSAGE[status]}
      </div>

      <div
        ref={mainRef}
        tabIndex={-1}
        role="region"
        aria-label={`Review of ${selection.request.slug} v${selection.request.version}`}
        style={{ outline: 'none' }}
      >
        <OnsiteReviewModalBody
          // Route param → keyed remount for a fresh per-submission body (parity
          // with the modal). Actions are hidden here — the sticky bar owns them.
          key={selection.request.id}
          selection={selection}
          onClose={onClose}
          hideInlineActions
        />
      </div>

      {/* Sticky approve/reject bar. Self-suppresses (renders null) for read-only
          approved/rejected history, so no empty bar appears there. Keyed per
          submission so its transient reject-mode/notes state resets on navigation. */}
      <ReviewActionBar
        key={`actions-${selection.request.id}`}
        selection={selection}
        onClose={handleActionSuccess}
        onStatusChange={setStatus}
        sticky
      />
    </>
  );
}
