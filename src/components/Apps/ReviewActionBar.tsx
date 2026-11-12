import { Alert, Box, Button, Chip, Group, Stack, Text, Textarea } from '@mantine/core';
import { IconArrowRight, IconCheck, IconClock, IconNote, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import {
  ListingMediaSplitControlForListing,
  MEDIA_SPLIT_NO_DECISION,
  type ListingMediaSplitResolution,
} from '~/components/Apps/ListingMediaSplitControl';
import { OnsiteApproveRatingWarning } from '~/components/Apps/ListingRatingNotices';
import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
import { REJECT_REASON_CHIPS } from '~/components/Apps/reviewDecisionFlow';
import {
  enqueueReviewApproval,
  undoReviewApproval,
  usePendingApprovalEntry,
} from '~/components/Apps/reviewApprovalToasts';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import type { ListingMediaSplitDecision } from '~/shared/constants/listing-media-split.constants';
import { listingFloorApproveRefusal } from '~/shared/utils/listing-publish-floor';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { trpcKeepalive } from '~/utils/trpc-keepalive';
import type { OnsiteReviewSelection } from '~/components/Apps/OnsiteReviewModal';
import {
  holdOverrideSatisfied,
  PublishRequestHoldsPanel,
  useOpenPublishRequestHolds,
} from '~/components/Apps/PublishRequestHoldsPanel';

/**
 * The moderator approve/reject control surface for an App Block review — extracted
 * from `OnsiteReviewModalBody` so BOTH the modal (inline footer, unchanged) and the
 * per-submission review PAGE (a sticky, always-reachable bottom bar) render the
 * exact same controls + mutations from ONE source.
 *
 * Owns the transient action state (`actionMode` / `approvalNotes` /
 * `rejectionReason`) and the two mutations. It is keyed by its callers on
 * `request.id` (the modal via the body's keyed remount; the page directly) so that
 * state resets per submission — no manual reset. Read-only (approved/rejected)
 * selections render nothing (there are no terminal actions to take), so a caller
 * can mount it unconditionally and it self-suppresses.
 *
 * Deliberately prop-clean of any onsite-only assumption so the deferred off-site
 * review page (Q7) can reuse it: it needs only a `selection` (request + mode), an
 * `onClose` (what to do after a successful action — the modal closes, the page
 * redirects to the queue), and two optional observers:
 *  - `busyRef`  — the modal shell writes this to refuse an in-flight close (the
 *                 pre-split `busyRef` close-guard). The page has no modal to guard,
 *                 so it omits this and uses `onStatusChange` instead.
 *  - `onStatusChange` — lets the page drive its `aria-live` status region and its
 *                 route-leave navigation guard off the mutation lifecycle.
 *
 * Imports no server infrastructure (pure constants, zod schemas and pure rating helpers),
 * so it stays browser-testable and never drags the tRPC server graph into the client bundle.
 */

export type ReviewActionStatus = 'idle' | 'submitting' | 'approved' | 'rejected' | 'error';

export function ReviewActionBar({
  selection,
  onClose,
  busyRef,
  onStatusChange,
  onActioned,
  sticky = false,
  approveAndNext = false,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
  /** Invoked after a successful approve/reject (modal closes / page redirects). */
  onClose: () => void;
  /** Modal-only: written each render so the shell can refuse an in-flight close. */
  busyRef?: { current: boolean };
  /** Page-only: mutation-lifecycle status for the aria-live region + leave-guard. */
  onStatusChange?: (status: ReviewActionStatus) => void;
  /** Fired after a successful approve/reject (before `onClose`). The unified review
   *  page passes the tab's `resetPaging` so the decided item leaves the accumulated
   *  list — symmetric with the off-site modal's `onActioned`. Purely additive: it
   *  does NOT touch the approve/reject mutation logic. */
  onActioned?: () => void | Promise<void>;
  /** Render as a pinned bottom action bar (page) vs an inline footer (modal). */
  sticky?: boolean;
  /**
   * The review PAGE's decision flow. The primary action becomes "Approve & next": it records a
   * DELAYED approval (10 s, undoable from a toast — `reviewApprovalToasts`) and calls `onClose`
   * at once, which the page uses to open the next pending submission. "Approve" stays as the
   * immediate, no-undo secondary. Off (the modal), the bar is the single "Approve + build" it
   * always was.
   */
  approveAndNext?: boolean;
}) {
  const utils = trpc.useUtils();
  const { request, mode } = selection;
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [reasonChip, setReasonChip] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  // The synchronous double-click guard for "Approve & next": set on the first click, before
  // any re-render could disable the button. The queue refuses a second enqueue of the same id
  // as well; this keeps the second click from even reaching it.
  const delayedApproveFired = useRef(false);
  /*
    🔴 THIS REQUEST'S OWN DELAYED APPROVAL. Browser Back inside the 10 s window lands on a
    request that is already queued for approval; offering the full bar there made "Approve &
    next" a silent no-op (the queue refuses a second enqueue) and let "Approve" / "Reject" race
    the timer, which then failed with a persistent "Could not approve" toast. So while the
    request is queued — or already approved by that queue — the bar shows that state instead,
    with the same Undo as the toast while the window is open.
  */
  const queued = usePendingApprovalEntry(request.id);
  useEffect(() => {
    // Undone (or failed and released): the request is actionable again, so a fresh
    // "Approve & next" must not be swallowed by the double-click guard of the last one.
    if (!queued) delayedApproveFired.current = false;
  }, [queued]);
  const [mediaSplitChoice, setMediaSplitChoice] = useState<ListingMediaSplitDecision | null>(null);
  // `null` until the listing's media has loaded: approving then would send a decision nobody saw.
  // `MEDIA_SPLIT_NO_DECISION` once it has but the split cannot be read: approve proceeds and sends
  // no decision, which the server carries out as it did before the split existed.
  const [mediaSplit, setMediaSplit] = useState<ListingMediaSplitResolution | null>(null);
  const splitStateUnknown = request.approveRating != null && mediaSplit == null;
  // The publish floor (icon + cover) the server refuses this approve on, from the same
  // predicate (`listingFactsForRequests` → `approveFloorMissing`). Approve is disabled and the
  // reason shown, rather than offered and refused.
  const floorMissing = request.approveFloorMissing ?? [];
  const floorBlocked = floorMissing.length > 0;
  const mediaSplitDecision =
    request.approveRating && mediaSplit && mediaSplit !== MEDIA_SPLIT_NO_DECISION
      ? mediaSplit
      : undefined;
  const openHolds = useOpenPublishRequestHolds(mode === 'pending' ? request.slug : null);
  const [holdOverrideReason, setHoldOverrideReason] = useState('');
  const holdBlocked = !holdOverrideSatisfied(openHolds.length, holdOverrideReason);

  const approveMut = trpc.blocks.approveRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Approved ${request.slug} v${request.version}. Build started.`,
      });
      onStatusChange?.('approved');
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listApprovedRequests.invalidate();
      await onActioned?.();
      onClose();
    },
    onError: (e) => {
      onStatusChange?.('error');
      showErrorNotification({
        title: 'Approve failed',
        error: new Error(e.message),
      });
    },
  });
  const rejectMut = trpc.blocks.rejectRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Rejected ${request.slug} v${request.version}.`,
      });
      onStatusChange?.('rejected');
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listRejectedRequests.invalidate();
      await onActioned?.();
      onClose();
    },
    onError: (e) => {
      onStatusChange?.('error');
      showErrorNotification({
        title: 'Reject failed',
        error: new Error(e.message),
      });
    },
  });

  const busy = approveMut.isPending || rejectMut.isPending;

  const approveInput = () => ({
    publishRequestId: request.id,
    approvalNotes: approvalNotes.trim() || undefined,
    ...(mediaSplitDecision ? { mediaSplit: mediaSplitDecision } : {}),
    ...(openHolds.length
      ? {
          holdOverrideReason: holdOverrideReason.trim(),
          holdOverrideIds: openHolds.map((h) => h.id),
        }
      : {}),
  });

  const approveLater = () => {
    if (delayedApproveFired.current) return;
    delayedApproveFired.current = true;
    const input = approveInput();
    const accepted = enqueueReviewApproval({
      id: request.id,
      label: `${request.slug} v${request.version}`,
      // `keepalive`: this send may start from `pagehide` (the tab closing), and a plain fetch
      // is cancelled with the page. Same procedure, input and wire format as the bar's own
      // immediate approve.
      commit: () => trpcKeepalive.blocks.approveRequest.mutate(input),
      onCommitted: async () => {
        await Promise.all([
          utils.blocks.listPendingRequests.invalidate(),
          utils.blocks.listApprovedRequests.invalidate(),
          utils.blocks.countReviewQueue?.invalidate?.(),
        ]);
      },
    });
    if (!accepted) return;
    void onActioned?.();
    onClose();
  };
  // Publish the in-flight state to the modal shell so its onClose can guard on it
  // (written during render so it is current by the time a close fires).
  if (busyRef) busyRef.current = busy;
  // Drive the page's aria-live / leave-guard while a mutation is running. Success
  // and error are reported explicitly from the mutation callbacks above; this only
  // announces the submitting phase (and never overwrites a terminal status, since
  // once busy the mutation is still pending).
  useEffect(() => {
    if (busy) onStatusChange?.('submitting');
  }, [busy, onStatusChange]);

  // Read-only history (approved/rejected) has no terminal action — render nothing
  // so a page can mount the bar unconditionally without an empty sticky shell.
  if (mode !== 'pending') return null;

  const actions =
    actionMode === 'reject' ? (
      <Stack gap="xs">
        {/* Common reasons PREFILL the field; the moderator can still edit the text, which is
            what the developer is shown. Reject… → a chip → Reject is three clicks. */}
        <Chip.Group
          multiple={false}
          value={reasonChip}
          onChange={(key) => {
            const chip = REJECT_REASON_CHIPS.find((c) => c.key === key);
            setReasonChip(key);
            if (chip) setRejectionReason(chip.text);
          }}
        >
          <Group gap={6} data-testid="apps-review-reject-chips">
            {REJECT_REASON_CHIPS.map((c) => (
              <Chip
                key={c.key}
                value={c.key}
                size="xs"
                disabled={busy}
                data-testid={`apps-review-reject-chip-${c.key}`}
              >
                {c.label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <ReasonGatedField
          value={rejectionReason}
          onChange={setRejectionReason}
          disabled={busy}
          label="Rejection reason"
          placeholder={`Explain what needs to change before this can be approved (≥${OFFSITE_MOD_REASON_MIN} chars, shown to the dev).`}
          testId="apps-review-reject-reason"
          minRows={3}
          maxRows={10}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
            Cancel
          </Button>
          <ReasonGatedSubmitButton
            onClick={() =>
              rejectMut.mutate({
                publishRequestId: request.id,
                rejectionReason: rejectionReason.trim(),
              })
            }
            gateOpen={reasonMeetsMin(rejectionReason)}
            busy={rejectMut.isPending}
            color="red"
            leftSection={<IconX size={14} />}
            label="Reject"
            testId="apps-review-reject-confirm"
          />
        </Group>
      </Stack>
    ) : (
      <Stack gap="xs">
        <PublishRequestHoldsPanel
          slug={request.slug}
          publishRequestId={request.id}
          kind="onsite"
          holds={openHolds}
          overrideReason={holdOverrideReason}
          onOverrideReasonChange={setHoldOverrideReason}
          disabled={busy}
        />
        {floorBlocked && (
          <Alert color="orange" variant="light" data-testid="apps-review-approve-floor">
            {listingFloorApproveRefusal(floorMissing)}
          </Alert>
        )}
        {request.approveRating && (
          <OnsiteApproveRatingWarning
            listingId={request.approveRating.listingId}
            declaredRating={request.approveRating.declared}
            mediaSplit={mediaSplit === 'split'}
          />
        )}
        {request.approveRating && (
          <ListingMediaSplitControlForListing
            listingId={request.approveRating.listingId}
            choice={mediaSplitChoice}
            onChoice={setMediaSplitChoice}
            onResolved={setMediaSplit}
            disabled={busy}
          />
        )}
        {(!approveAndNext || showNotes) && (
          <Textarea
            label="Approval notes (optional)"
            autosize
            minRows={2}
            maxRows={6}
            placeholder="Optional notes attached to the approval record."
            value={approvalNotes}
            onChange={(e) => setApprovalNotes(e.currentTarget.value)}
            disabled={busy}
          />
        )}
        <Group justify="flex-end" gap="xs">
          {approveAndNext && !showNotes && (
            <Button
              variant="subtle"
              color="gray"
              size="sm"
              leftSection={<IconNote size={14} />}
              onClick={() => setShowNotes(true)}
              disabled={busy}
              mr="auto"
            >
              Add note
            </Button>
          )}
          <Button
            color="red"
            variant="default"
            leftSection={<IconX size={14} />}
            onClick={() => setActionMode('reject')}
            disabled={busy}
          >
            Reject…
          </Button>
          {approveAndNext ? (
            <>
              <Button
                variant="default"
                leftSection={<IconCheck size={14} />}
                onClick={() => approveMut.mutate(approveInput())}
                disabled={busy || splitStateUnknown || floorBlocked || holdBlocked}
                loading={approveMut.isPending}
                title="Approve now, with no undo window"
                data-testid="apps-review-approve-now-button"
              >
                Approve
              </Button>
              <Button
                color="green"
                rightSection={<IconArrowRight size={14} />}
                onClick={approveLater}
                disabled={busy || splitStateUnknown || floorBlocked || holdBlocked}
                data-testid="apps-review-approve-next"
              >
                Approve &amp; next
              </Button>
            </>
          ) : (
            <Button
              color="green"
              leftSection={<IconCheck size={14} />}
              onClick={() => approveMut.mutate(approveInput())}
              disabled={busy || splitStateUnknown || floorBlocked || holdBlocked}
              loading={approveMut.isPending}
            >
              Approve + build
            </Button>
          )}
        </Group>
        {approveAndNext && (
          <Text size="xs" c="dimmed" ta="right">
            Approve &amp; next waits 10 seconds so you can undo, then approves and starts the build.
          </Text>
        )}
      </Stack>
    );

  // While this request's own delayed approval is queued (or done), that state replaces the
  // actions — see `queued` above.
  const inner = queued ? (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="sm"
      data-testid="apps-review-bar-queued"
      data-queued-status={queued.status}
    >
      <Group gap={6} wrap="nowrap">
        {queued.status === 'committed' ? <IconCheck size={16} /> : <IconClock size={16} />}
        <Text size="sm">
          {queued.status === 'pending'
            ? `Approval pending — ${queued.label} will be approved when the undo window ends.`
            : queued.status === 'committing'
            ? `Approving ${queued.label}…`
            : `Approved ${queued.label}. Build started.`}
        </Text>
      </Group>
      {queued.status === 'pending' && (
        <Button
          size="sm"
          variant="filled"
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            // 🔴 This view replaces the actions the instant "Approve & next" enqueues, so the
            // SECOND click of a double click on that button lands here. A click with
            // `detail > 1` is that second click, never a deliberate Undo.
            if (e.detail > 1) return;
            undoReviewApproval(request.id, { navigate: false });
          }}
          data-testid="apps-review-bar-undo"
        >
          Undo
        </Button>
      )}
    </Group>
  ) : (
    actions
  );

  if (!sticky) return inner;

  // Sticky bottom bar for the page: pinned to the viewport bottom so a mod never
  // has to scroll the long tabbed report to act. Plain DOM controls in normal tab
  // order (no focus trap); respects the mobile safe-area inset.
  return (
    <Box
      role="group"
      aria-label="Review actions"
      data-testid="apps-review-action-bar"
      style={REVIEW_ACTION_BAR_STICKY_STYLE}
    >
      {inner}
    </Box>
  );
}

/**
 * The sticky bar's geometry.
 *
 * 🔴 IT STICKS ABOVE THE APP FOOTER, NOT AT `bottom: 0`. The site footer is itself
 * `sticky bottom-0 z-50` in the same scroll container, so a bar at `bottom: 0` with a lower
 * z-index slid UNDER it on any page long enough to scroll — exactly when the bar is needed
 * (a long code diff, a live preview). `--app-footer-offset` (globals.css) is the footer's
 * current height while it is shown and unset while it is slid away, so the bar rides on top
 * of the footer and drops to the edge with it.
 *
 * 🔴 AND IT KEEPS THE BOTTOM-RIGHT CLEAR. The footer's floating cluster (scroll-to-top +
 * assistant) sits just above the footer at the right edge — i.e. over this bar's right end,
 * where Approve lives. `paddingRight` reserves that corner so the buttons end before it.
 */
export const REVIEW_ACTION_BAR_FAB_GUTTER_PX = 96;

const REVIEW_ACTION_BAR_STICKY_STYLE: React.CSSProperties = {
  position: 'sticky',
  bottom: 'var(--app-footer-offset, 0px)',
  // Above the page's own content (sticky diff headers are z 1), below the footer (z 50).
  zIndex: 40,
  background: 'var(--mantine-color-body)',
  borderTop: '1px solid var(--mantine-color-default-border)',
  boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.08)',
  marginLeft: 'calc(-1 * var(--mantine-spacing-md))',
  marginRight: 'calc(-1 * var(--mantine-spacing-md))',
  marginBottom: 'calc(-1 * var(--mantine-spacing-md))',
  paddingLeft: 'var(--mantine-spacing-md)',
  paddingRight: `calc(var(--mantine-spacing-md) + ${REVIEW_ACTION_BAR_FAB_GUTTER_PX}px)`,
  paddingTop: 'var(--mantine-spacing-sm)',
  // Was a bare `env(safe-area-inset-bottom)`, which had two problems: it
  // resolved to 0 on every device (nothing shipped `viewport-fit=cover`
  // until this change), and it carried no `env()` fallback — so in a UA
  // that does not know the variable the WHOLE declaration is invalid at
  // computed-value time and the bar loses its padding entirely rather than
  // falling back to the spacing. `--safe-area-inset-bottom` (globals.css)
  // carries the `, 0px` fallback once, for every call site.
  paddingBottom: 'max(var(--mantine-spacing-sm), var(--safe-area-inset-bottom))',
};
