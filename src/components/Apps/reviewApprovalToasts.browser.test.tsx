import { beforeEach, describe, expect, test, vi } from 'vitest';

const shown = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@mantine/notifications', () => ({
  showNotification: (n: Record<string, unknown>) => shown.push(n),
  hideNotification: vi.fn(),
}));

const { enqueueReviewApproval } = await import('./reviewApprovalToasts');
const { createPendingApprovalQueue } = await import('./pendingApprovalQueue');

/** The notice raised once a delayed ("Approve & next") approval commits. */
async function commitAndReadNotice(
  committedNotice?: () => { title: string; message: string } | null
) {
  const queue = createPendingApprovalQueue();
  const onCommitted = vi.fn();
  expect(
    enqueueReviewApproval({
      id: 'req-1',
      label: 'my-app v1.0.0',
      commit: async () => ({}),
      onCommitted,
      committedNotice,
      queue,
    })
  ).toBe(true);
  await queue.commitNow('req-1');
  expect(onCommitted).toHaveBeenCalled();
  return shown.at(-1);
}

beforeEach(() => {
  shown.length = 0;
});

describe('a delayed approval that commits', () => {
  test('says "Build started" when the approve took effect', async () => {
    const notice = await commitAndReadNotice(() => null);
    expect(notice?.message).toBe('Approved my-app v1.0.0. Build started.');
  });

  test('🔴 a late hold re-suspended the app: says so, never "Build started"', async () => {
    const notice = await commitAndReadNotice(() => ({
      title: 'App suspended: a review hold was placed during the approve',
      message: 'my-app v1.0.0 was not built.',
    }));
    expect(notice).toMatchObject({
      color: 'red',
      title: 'App suspended: a review hold was placed during the approve',
      message: 'my-app v1.0.0 was not built.',
    });
  });
});
