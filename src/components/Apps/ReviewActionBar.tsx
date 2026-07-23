import { Box, Button, Group, Stack, Textarea } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { OnsiteReviewSelection } from '~/components/Apps/OnsiteReviewModal';

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
 * SERVER-GRAPH-FREE (only pure constant/zod imports), so it stays browser-testable
 * and never drags the tRPC server graph into the client bundle.
 */

export type ReviewActionStatus = 'idle' | 'submitting' | 'approved' | 'rejected' | 'error';

export function ReviewActionBar({
  selection,
  onClose,
  busyRef,
  onStatusChange,
  sticky = false,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
  /** Invoked after a successful approve/reject (modal closes / page redirects). */
  onClose: () => void;
  /** Modal-only: written each render so the shell can refuse an in-flight close. */
  busyRef?: { current: boolean };
  /** Page-only: mutation-lifecycle status for the aria-live region + leave-guard. */
  onStatusChange?: (status: ReviewActionStatus) => void;
  /** Render as a pinned bottom action bar (page) vs an inline footer (modal). */
  sticky?: boolean;
}) {
  const utils = trpc.useUtils();
  const { request, mode } = selection;
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');

  const approveMut = trpc.blocks.approveRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Approved ${request.slug} v${request.version}. Build started.`,
      });
      onStatusChange?.('approved');
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listApprovedRequests.invalidate();
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

  const inner =
    actionMode === 'reject' ? (
      <Stack gap="xs">
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
        <Group justify="flex-end" gap="xs">
          <Button
            color="red"
            variant="default"
            leftSection={<IconX size={14} />}
            onClick={() => setActionMode('reject')}
            disabled={busy}
          >
            Reject…
          </Button>
          <Button
            color="green"
            leftSection={<IconCheck size={14} />}
            onClick={() =>
              approveMut.mutate({
                publishRequestId: request.id,
                approvalNotes: approvalNotes.trim() || undefined,
              })
            }
            disabled={busy}
            loading={approveMut.isPending}
          >
            Approve + build
          </Button>
        </Group>
      </Stack>
    );

  if (!sticky) return inner;

  // Sticky bottom bar for the page: pinned to the viewport bottom so a mod never
  // has to scroll the long tabbed report to act. Plain DOM controls in normal tab
  // order (no focus trap); respects the mobile safe-area inset.
  return (
    <Box
      role="group"
      aria-label="Review actions"
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 3,
        background: 'var(--mantine-color-body)',
        borderTop: '1px solid var(--mantine-color-default-border)',
        marginLeft: 'calc(-1 * var(--mantine-spacing-md))',
        marginRight: 'calc(-1 * var(--mantine-spacing-md))',
        marginBottom: 'calc(-1 * var(--mantine-spacing-md))',
        paddingLeft: 'var(--mantine-spacing-md)',
        paddingRight: 'var(--mantine-spacing-md)',
        paddingTop: 'var(--mantine-spacing-md)',
        paddingBottom: 'max(var(--mantine-spacing-md), env(safe-area-inset-bottom))',
      }}
    >
      {inner}
    </Box>
  );
}
