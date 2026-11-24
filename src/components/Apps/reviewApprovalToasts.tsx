import { Button, Group, Progress, Stack, Text } from '@mantine/core';
import {
  hideNotification,
  notificationsStore,
  showNotification,
  type NotificationData,
} from '@mantine/notifications';
import { IconAlertTriangle, IconClock } from '@tabler/icons-react';
import Router from 'next/router';
import { useEffect, useMemo, useSyncExternalStore, useState } from 'react';
import {
  bindPendingApprovalLifecycle,
  isInReviewArea,
  PENDING_APPROVAL_DELAY_MS,
  reviewApprovalQueue,
  type PendingApprovalEntry,
  type PendingApprovalQueue,
} from '~/components/Apps/pendingApprovalQueue';

/**
 * The UI half of the delayed "Approve & next": ONE decisions toast that counts pending
 * approvals down with Undo and tallies what was decided, the persistent-failure toasts, and the
 * one-time binding of the queue to the ways a moderator can leave (see
 * `bindPendingApprovalLifecycle`). The engine itself is `pendingApprovalQueue.ts`.
 *
 * 🔴 TOASTS, NOT PAGE STATE, because the page that enqueued the approval is gone by the time
 * it commits — the same click navigated to the next submission. Mantine's notifications live
 * at the app root, so the countdown keeps ticking across review pages.
 *
 * 🔴 ONE TOAST, AT THE TOP. Each approval used to raise its own countdown toast and then a
 * second "Approved … Build started." toast, all bottom-right — the corner the sticky review
 * bar's Approve buttons sit in. Approving a few in a row stacked them over the buttons until
 * they timed out. Now every review decision feeds one toast (`REVIEW_DECISIONS_TOAST_ID`) at
 * `REVIEW_TOAST_POSITION`, which reads "2 approvals pending · 1 approved" and lists each
 * pending approval with its own Undo. Its body is a live component subscribed to the queue and
 * the tally, so it updates in place without `updateNotification` — which silently does nothing
 * once a toast has closed (see `buildReviewConsentNotification` in `pageBlockHostLogic.ts`).
 * It never auto-closes on Mantine's timer; it is hidden by `settle` a few seconds after the
 * last pending approval resolves, and every new decision re-shows it by id when it is gone.
 *
 * Failures (and a late hold that re-suspended an approve) stay SEPARATE and PERSISTENT, at the
 * same position: the moderator has to act on them.
 */

/** Where every review-decision toast goes. Per notification, so other pages keep theirs. */
// The package index does not export `NotificationPosition`; the per-notification field is its type.
export const REVIEW_TOAST_POSITION: NonNullable<NotificationData['position']> = 'top-center';
export const REVIEW_DECISIONS_TOAST_ID = 'review-decisions';
/** How long the decisions toast stays once nothing is pending any more. */
export const REVIEW_DECISIONS_LINGER_MS = 4000;

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

export type ReviewDecisionTally = { approved: number; rejected: number; undone: number };

/**
 * The decisions toast's headline: "2 approvals pending · 1 approved · 1 undone". `pending`
 * counts approvals still in their undo window or being sent.
 */
export function reviewDecisionsSummary(t: { pending: number } & ReviewDecisionTally): string {
  const parts: string[] = [];
  if (t.pending > 0) parts.push(`${t.pending} approval${t.pending === 1 ? '' : 's'} pending`);
  if (t.approved > 0) parts.push(`${t.approved} approved`);
  if (t.rejected > 0) parts.push(`${t.rejected} rejected`);
  if (t.undone > 0) parts.push(`${t.undone} undone`);
  return parts.join(' · ');
}

const isActive = (e: PendingApprovalEntry) => e.status === 'pending' || e.status === 'committing';

/** The line under the headline naming the newest decision, so the toast says WHICH app. */
export function reviewDecisionLine(kind: keyof ReviewDecisionTally, label: string): string {
  if (kind === 'approved') return `Approved ${label}. Build started.`;
  if (kind === 'rejected') return `Rejected ${label}.`;
  return `Undone — ${label} was not approved.`;
}

/** The tally and the show/hide timing of ONE queue's decisions toast. */
function createDecisionsToast(queue: PendingApprovalQueue) {
  const zero: ReviewDecisionTally = { approved: 0, rejected: 0, undone: 0 };
  let tally = zero;
  let last: string | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const clearHide = () => {
    if (hideTimer != null) clearTimeout(hideTimer);
    hideTimer = null;
  };
  const isShown = () => {
    const state = notificationsStore.getState();
    return [...state.notifications, ...state.queue].some((n) => n.id === REVIEW_DECISIONS_TOAST_ID);
  };

  const toast = {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getTally: () => tally,
    getLast: () => last,
    /**
     * Show the toast if it is not up. A toast that is gone (hidden, or cleared by anything)
     * starts a fresh tally: the count is "since this toast appeared", never the whole session.
     */
    ensureShown() {
      clearHide();
      if (isShown()) return;
      tally = zero;
      last = null;
      emit();
      showNotification({
        id: REVIEW_DECISIONS_TOAST_ID,
        position: REVIEW_TOAST_POSITION,
        icon: <IconClock size={18} />,
        color: 'blue',
        // Hidden by `settle`, never by a Mantine timer racing the countdown.
        autoClose: false,
        withCloseButton: false,
        message: <ReviewDecisionsToastBody queue={queue} toast={toast} />,
      });
    },
    count(kind: keyof ReviewDecisionTally, label: string) {
      tally = { ...tally, [kind]: tally[kind] + 1 };
      last = reviewDecisionLine(kind, label);
      emit();
    },
    /** Hide the toast once nothing is pending, after a short linger; keep it while anything is. */
    settle() {
      clearHide();
      if (queue.getSnapshot().some(isActive)) return;
      hideTimer = setTimeout(() => {
        hideTimer = null;
        hideNotification(REVIEW_DECISIONS_TOAST_ID);
      }, REVIEW_DECISIONS_LINGER_MS);
    },
  };
  return toast;
}

type DecisionsToast = ReturnType<typeof createDecisionsToast>;
const decisionsToasts = new WeakMap<PendingApprovalQueue, DecisionsToast>();
function decisionsToastFor(queue: PendingApprovalQueue): DecisionsToast {
  let t = decisionsToasts.get(queue);
  if (!t) {
    t = createDecisionsToast(queue);
    decisionsToasts.set(queue, t);
  }
  return t;
}

/**
 * An IMMEDIATE approve or reject from the review bar: counted in the same decisions toast
 * instead of raising a toast of its own.
 */
export function noteReviewDecision(
  kind: 'approved' | 'rejected',
  label: string,
  queue: PendingApprovalQueue = reviewApprovalQueue
) {
  const toast = decisionsToastFor(queue);
  toast.ensureShown();
  toast.count(kind, label);
  toast.settle();
}

/**
 * The Undo of every approval still in its window, by request id — so the review page's own
 * action bar (Back to a request inside its window) offers the SAME undo as the toast, rather
 * than a second, drifting copy. Removed once the entry leaves the window (committed, undone or
 * failed).
 */
const undoHandlers = new Map<string, (opts?: { navigate?: boolean }) => boolean>();

/**
 * Undo a pending approval exactly as the toast's Undo does. `navigate: false` when the caller
 * is already showing the request (the action bar). `false` when there was nothing to undo.
 */
export function undoReviewApproval(
  id: string,
  opts?: { navigate?: boolean },
  queue: PendingApprovalQueue = reviewApprovalQueue
): boolean {
  const handler = undoHandlers.get(id);
  if (handler) return handler(opts);
  return queue.undo(id);
}

/** Where the router is now, or `null` outside a Next router (a component harness). */
function currentPath(): string | null {
  try {
    return typeof Router.asPath === 'string' ? Router.asPath : null;
  } catch {
    return null;
  }
}

/** The decisions toast's body: the headline, then one countdown row per pending approval. */
function ReviewDecisionsToastBody({
  queue,
  toast,
}: {
  queue: PendingApprovalQueue;
  toast: DecisionsToast;
}) {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const tally = useSyncExternalStore(toast.subscribe, toast.getTally, toast.getTally);
  const last = useSyncExternalStore(toast.subscribe, toast.getLast, toast.getLast);
  const active = entries.filter(isActive);
  return (
    <Stack gap={8} data-testid="apps-review-decisions-toast">
      <Text size="sm" fw={600} data-testid="apps-review-decisions-summary">
        {reviewDecisionsSummary({ pending: active.length, ...tally })}
      </Text>
      {last && (
        <Text size="xs" c="dimmed" data-testid="apps-review-decisions-last">
          {last}
        </Text>
      )}
      {active.map((e) => (
        <PendingApprovalCountdown
          key={e.id}
          entry={e}
          onUndo={() => undoReviewApproval(e.id, undefined, queue)}
        />
      ))}
    </Stack>
  );
}

/** One pending approval's countdown row. Re-renders on its own 250ms tick. */
function PendingApprovalCountdown({
  entry,
  onUndo,
}: {
  entry: PendingApprovalEntry;
  onUndo: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remainingMs = Math.max(0, entry.dueAt - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const committing = entry.status === 'committing';
  return (
    <Stack gap={4} data-testid="apps-review-approve-countdown">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          {committing ? `Approving ${entry.label}…` : `Approving ${entry.label} in ${seconds}s`}
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
  /** A notice that replaces counting the approval when the commit did not take effect. */
  committedNotice?: () => { title: string; message: string } | null;
  /** Where Undo / a failure sends the moderator back to. Defaults to the request's page. */
  reviewHref?: string;
  queue?: PendingApprovalQueue;
};

/**
 * Record a delayed approval and show it in the decisions toast. Returns `false` when this
 * request already has an approval pending / in flight / committed (the double-click guard) —
 * the caller then does nothing.
 */
export function enqueueReviewApproval({
  id,
  label,
  commit,
  onCommitted,
  committedNotice,
  reviewHref = `/apps/review/${id}`,
  queue = reviewApprovalQueue,
}: EnqueueReviewApprovalArgs): boolean {
  ensureLifecycleBound(queue);
  const accepted = queue.enqueue({ id, label, commit });
  if (!accepted) return false;
  const toast = decisionsToastFor(queue);

  const undo = ({ navigate = true }: { navigate?: boolean } = {}) => {
    if (!queue.undo(id)) return false;
    // Back to the submission the moderator just un-approved. (The review page also drops its
    // "No more app submissions waiting" state on this undo — `useNextPendingReview` — since
    // after the LAST submission this push is to the URL it is already on.)
    if (navigate) void Router.push(reviewHref).catch(() => undefined);
    return true;
  };
  undoHandlers.set(id, undo);

  toast.ensureShown();

  const unsubscribe = queue.subscribe((event) => {
    if (event.entry.id !== id) return;
    if (event.type === 'committed' || event.type === 'undone' || event.type === 'failed') {
      if (undoHandlers.get(id) === undo) undoHandlers.delete(id);
    }
    if (event.type === 'committed') {
      unsubscribe();
      const notice = committedNotice?.();
      if (notice) {
        // Not an approval that took: a persistent notice of its own, never "approved".
        showNotification({
          id: `review-approve-notice-${id}`,
          position: REVIEW_TOAST_POSITION,
          color: 'red',
          title: notice.title,
          message: notice.message,
          autoClose: false,
        });
      } else {
        toast.count('approved', label);
      }
      toast.settle();
      void onCommitted?.();
    } else if (event.type === 'undone') {
      unsubscribe();
      toast.count('undone', label);
      toast.settle();
    } else if (event.type === 'failed') {
      unsubscribe();
      toast.settle();
      const errorId = `review-approve-failed-${id}`;
      const message =
        event.entry.error instanceof Error ? event.entry.error.message : 'The approval failed.';
      // PERSISTENT: a failed approval must not vanish on a timer — the request is still
      // pending and the moderator has to act on it.
      showNotification({
        id: errorId,
        position: REVIEW_TOAST_POSITION,
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
                  if (
                    enqueueReviewApproval({
                      id,
                      label,
                      commit,
                      onCommitted,
                      committedNotice,
                      reviewHref,
                      queue,
                    })
                  )
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
      // Re-open the request it failed on, so the moderator is looking at it — but only while
      // they are still in the review area. A moderator who has LEFT it (the leave is what
      // committed the approval) is not yanked back; the persistent toast's "Open request" is
      // the way back.
      const here = currentPath();
      if (here != null && isInReviewArea(here)) void Router.push(reviewHref).catch(() => undefined);
    }
  });
  return true;
}

/**
 * This request's entry in the approval queue (pending, committing or committed), or
 * `undefined` — subscribe from a component. A failed approval is released from the queue, so
 * it reads `undefined` and the request is actionable again.
 */
export function usePendingApprovalEntry(
  id: string,
  queue: PendingApprovalQueue = reviewApprovalQueue
): PendingApprovalEntry | undefined {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return entries.find((e) => e.id === id);
}

/** Ids with an approval pending or in flight — subscribe from a component. */
export function usePendingApprovalIds(queue: PendingApprovalQueue = reviewApprovalQueue) {
  const entries = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  // Memoised on the snapshot, which only changes identity when the queue changes.
  return useMemo(() => new Set(entries.filter(isActive).map((e) => e.id)), [entries]);
}
