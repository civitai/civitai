import { Button, Group, Progress, Stack, Text } from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconClock } from '@tabler/icons-react';
import Router from 'next/router';
import { useEffect, useMemo, useSyncExternalStore, useState } from 'react';
import {
  bindPendingApprovalLifecycle,
  PENDING_APPROVAL_DELAY_MS,
  reviewApprovalQueue,
  type PendingApprovalQueue,
} from '~/components/Apps/pendingApprovalQueue';

/**
 * The UI half of the delayed "Approve & next": the countdown toast with Undo, the success /
 * persistent-failure toasts, and the one-time binding of the queue to the ways a moderator can
 * leave (see `bindPendingApprovalLifecycle`). The engine itself is `pendingApprovalQueue.ts`.
 *
 * 🔴 TOASTS, NOT PAGE STATE, because the page that enqueued the approval is gone by the time
 * it commits — the same click navigated to the next submission. Mantine's notifications live
 * at the app root, so the countdown keeps ticking across review pages.
 */

let lifecycleBound = false;

function ensureLifecycleBound(queue: PendingApprovalQueue) {
  if (lifecycleBound || typeof window === 'undefined') return;
  try {
    bindPendingApprovalLifecycle(queue, {
      routerEvents: Router.events,
      win: window,
      doc: document,
    });
    lifecycleBound = true;
  } catch {
    // No Next router (a component test harness): the timers still commit on schedule.
  }
}

const toastId = (id: string) => `review-approve-${id}`;

/** The countdown body of the pending-approval toast. Re-renders on its own 250ms tick. */
function PendingApprovalCountdown({
  id,
  label,
  queue,
  onUndo,
}: {
  id: string;
  label: string;
  queue: PendingApprovalQueue;
  onUndo: () => void;
}) {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const entry = entries.find((e) => e.id === id);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remainingMs = entry ? Math.max(0, entry.dueAt - now) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const committing = entry?.status === 'committing';
  return (
    <Stack gap={6} data-testid="apps-review-approve-countdown">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          {committing ? `Approving ${label}…` : `Approving ${label} in ${seconds}s`}
        </Text>
        {/* Undo only. The toast offers no "approve now": the immediate approve is the bar's
            own "Approve" button, and a third approve path here was not asked for. */}
        {!committing && (
          <Button
            size="compact-xs"
            variant="filled"
            onClick={onUndo}
            data-testid="apps-review-approve-undo"
          >
            Undo
          </Button>
        )}
      </Group>
      <Progress
        size="xs"
        value={committing ? 100 : (remainingMs / PENDING_APPROVAL_DELAY_MS) * 100}
        animated={committing}
        aria-hidden
      />
    </Stack>
  );
}

export type EnqueueReviewApprovalArgs = {
  id: string;
  /** "my-app v1.2.0" — what the toasts call it. */
  label: string;
  /** Sends `approveRequest`. Built by the caller from the tRPC client. */
  commit: () => Promise<unknown>;
  /** After a successful commit (refresh the queue lists). */
  onCommitted?: () => void | Promise<void>;
  /** Where Undo / a failure sends the moderator back to. Defaults to the request's page. */
  reviewHref?: string;
  queue?: PendingApprovalQueue;
};

/**
 * Record a delayed approval and raise its countdown toast. Returns `false` when this request
 * already has an approval pending / in flight / committed (the double-click guard) — the caller
 * then does nothing.
 */
export function enqueueReviewApproval({
  id,
  label,
  commit,
  onCommitted,
  reviewHref = `/apps/review/${id}`,
  queue = reviewApprovalQueue,
}: EnqueueReviewApprovalArgs): boolean {
  ensureLifecycleBound(queue);
  const accepted = queue.enqueue({ id, label, commit });
  if (!accepted) return false;

  const undo = () => {
    if (queue.undo(id)) {
      hideNotification(toastId(id));
      showNotification({
        message: `Undone — ${label} was not approved.`,
        color: 'gray',
        autoClose: 3000,
      });
      // Back to the submission the moderator just un-approved.
      void Router.push(reviewHref).catch(() => undefined);
    }
  };

  showNotification({
    id: toastId(id),
    icon: <IconClock size={18} />,
    color: 'blue',
    // Closed by the queue's own events, never by a timer racing the countdown.
    autoClose: false,
    withCloseButton: false,
    message: <PendingApprovalCountdown id={id} label={label} queue={queue} onUndo={undo} />,
  });

  const unsubscribe = queue.subscribe((event) => {
    if (event.entry.id !== id) return;
    if (event.type === 'committed') {
      unsubscribe();
      hideNotification(toastId(id));
      showNotification({
        icon: <IconCheck size={18} />,
        color: 'green',
        message: `Approved ${label}. Build started.`,
        autoClose: 3000,
      });
      void onCommitted?.();
    } else if (event.type === 'undone') {
      unsubscribe();
    } else if (event.type === 'failed') {
      unsubscribe();
      hideNotification(toastId(id));
      const errorId = `review-approve-failed-${id}`;
      const message =
        event.entry.error instanceof Error ? event.entry.error.message : 'The approval failed.';
      // PERSISTENT: a failed approval must not vanish on a timer — the request is still
      // pending and the moderator has to act on it.
      showNotification({
        id: errorId,
        icon: <IconAlertTriangle size={18} />,
        color: 'red',
        title: `Could not approve ${label}`,
        autoClose: false,
        message: (
          <Stack gap={6} data-testid="apps-review-approve-failed">
            <Text size="sm">{message}</Text>
            <Group gap={6}>
              <Button
                size="compact-xs"
                color="red"
                onClick={() => {
                  hideNotification(errorId);
                  if (enqueueReviewApproval({ id, label, commit, onCommitted, reviewHref, queue }))
                    void queue.commitNow(id);
                }}
                data-testid="apps-review-approve-retry"
              >
                Retry
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => {
                  hideNotification(errorId);
                  void Router.push(reviewHref).catch(() => undefined);
                }}
              >
                Open request
              </Button>
            </Group>
          </Stack>
        ),
      });
      // Re-open the request it failed on, so the moderator is looking at it.
      void Router.push(reviewHref).catch(() => undefined);
    }
  });
  return true;
}

/** Ids with an approval pending or in flight — subscribe from a component. */
export function usePendingApprovalIds(queue: PendingApprovalQueue = reviewApprovalQueue) {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  // Memoised on the snapshot, which only changes identity when the queue changes.
  return useMemo(
    () =>
      new Set(
        entries.filter((e) => e.status === 'pending' || e.status === 'committing').map((e) => e.id)
      ),
    [entries]
  );
}
