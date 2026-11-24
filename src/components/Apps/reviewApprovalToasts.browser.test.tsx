import {
  cleanNotifications,
  cleanNotificationsQueue,
  notificationsStore,
} from '@mantine/notifications';
import type * as NotificationsMod from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The review decisions toast, read from Mantine's own notification store: what is up, at which
 * position, and for how long. (The rendered body is driven through the real page in
 * `ReviewDecisionFlow.browser.test.tsx`.)
 */

const shown = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@mantine/notifications', async (importOriginal) => {
  const real = await importOriginal<typeof NotificationsMod>();
  return {
    ...real,
    showNotification: (n: Parameters<typeof real.showNotification>[0]) => {
      shown.push(n as unknown as Record<string, unknown>);
      return real.showNotification(n);
    },
  };
});

const {
  enqueueReviewApproval,
  noteReviewDecision,
  REVIEW_DECISIONS_LINGER_MS,
  reviewDecisionsSummary,
} = await import('./reviewApprovalToasts');
const { createPendingApprovalQueue } = await import('./pendingApprovalQueue');

/** Everything Mantine holds, displayed or queued behind the per-position limit. */
const held = () => {
  const s = notificationsStore.getState();
  return [...s.notifications, ...s.queue];
};

function enqueue(queue: ReturnType<typeof createPendingApprovalQueue>, n: number, over = {}) {
  expect(
    enqueueReviewApproval({
      id: `req-${n}`,
      label: `app-${n} v1.0.0`,
      commit: async () => ({}),
      queue,
      ...over,
    })
  ).toBe(true);
}

/** A queue whose own 10 s timer never fires: commits happen only through `commitNow`. */
const manualQueue = () =>
  createPendingApprovalQueue({
    timers: { setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 },
  });

beforeEach(() => {
  shown.length = 0;
  cleanNotifications();
  cleanNotificationsQueue();
});
afterEach(() => {
  vi.useRealTimers();
  cleanNotifications();
  cleanNotificationsQueue();
});

describe('the decisions headline', () => {
  test.each([
    [{ pending: 1, approved: 0, rejected: 0, undone: 0 }, '1 approval pending'],
    [{ pending: 2, approved: 1, rejected: 0, undone: 0 }, '2 approvals pending · 1 approved'],
    [{ pending: 0, approved: 3, rejected: 1, undone: 2 }, '3 approved · 1 rejected · 2 undone'],
  ])('%o → "%s"', (tally, text) => {
    expect(reviewDecisionsSummary(tally)).toBe(text);
  });
});

describe('🔴 many decisions hold ONE toast, at the top — never one per approval', () => {
  test('three approvals, a commit, an undo and a reject: one notification, top-center', async () => {
    const queue = manualQueue();
    enqueue(queue, 1);
    enqueue(queue, 2);
    enqueue(queue, 3);
    await queue.commitNow('req-1');
    queue.undo('req-2');
    noteReviewDecision('rejected', queue);
    expect(held().map((n) => [n.id, n.position])).toEqual([['review-decisions', 'top-center']]);
    // No "Approved … Build started." or "Undone — …" toast of its own.
    expect(shown.map((n) => n.id)).toEqual(['review-decisions']);
  });

  test('a late hold is a PERSISTENT red notice at the top, never counted as approved', async () => {
    const queue = manualQueue();
    enqueue(queue, 1, {
      committedNotice: () => ({
        title: 'App suspended: a review hold was placed during the approve',
        message: 'app-1 v1.0.0 was not built.',
      }),
    });
    await queue.commitNow('req-1');
    expect(held().find((n) => n.id === 'review-approve-notice-req-1')).toMatchObject({
      color: 'red',
      title: 'App suspended: a review hold was placed during the approve',
      message: 'app-1 v1.0.0 was not built.',
      autoClose: false,
      position: 'top-center',
    });
  });

  test('a failed commit is a PERSISTENT toast with Retry, at the top', async () => {
    const queue = manualQueue();
    enqueue(queue, 1, { commit: async () => Promise.reject(new Error('listing floor not met')) });
    await queue.commitNow('req-1');
    expect(held().find((n) => n.id === 'review-approve-failed-req-1')).toMatchObject({
      title: 'Could not approve app-1 v1.0.0',
      autoClose: false,
      position: 'top-center',
    });
  });
});

describe('when the decisions toast goes away', () => {
  test('🔴 it stays while anything is pending, and leaves REVIEW_DECISIONS_LINGER_MS after the last one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queue = manualQueue();
    enqueue(queue, 1);
    enqueue(queue, 2);
    await queue.commitNow('req-1');
    // req-2 still pending: no amount of time hides the toast.
    vi.advanceTimersByTime(REVIEW_DECISIONS_LINGER_MS * 5);
    expect(held().map((n) => n.id)).toEqual(['review-decisions']);

    await queue.commitNow('req-2');
    vi.advanceTimersByTime(REVIEW_DECISIONS_LINGER_MS - 1);
    expect(held().map((n) => n.id)).toEqual(['review-decisions']);
    vi.advanceTimersByTime(1);
    expect(held()).toEqual([]);
  });

  test('a failure toast is not taken down with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queue = manualQueue();
    enqueue(queue, 1, { commit: async () => Promise.reject(new Error('listing floor not met')) });
    await queue.commitNow('req-1');
    vi.advanceTimersByTime(REVIEW_DECISIONS_LINGER_MS * 5);
    expect(held().map((n) => n.id)).toEqual(['review-approve-failed-req-1']);
  });

  test('a decision inside the linger keeps it up (the hide is cancelled, not raced)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queue = manualQueue();
    enqueue(queue, 1);
    await queue.commitNow('req-1');
    vi.advanceTimersByTime(REVIEW_DECISIONS_LINGER_MS - 1);
    enqueue(queue, 2);
    vi.advanceTimersByTime(REVIEW_DECISIONS_LINGER_MS * 5);
    expect(held().map((n) => n.id)).toEqual(['review-decisions']);
  });
});
