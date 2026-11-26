import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `notifyAppBlockSubmitter` helper — forwards to `createNotification` with the right
 * shape via its dynamic import. Only the notifications client is mocked; the helper's
 * static imports are a type (erased) and a dependency-free leaf, so nothing else is pulled. `~/server/common/enums`
 * is the REAL module (so we assert the actual `NotificationCategory.System` value).
 */

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { notifyAppBlockSubmitter } = await import('~/server/services/blocks/app-block-notify');

/** The details the one notification was created with. */
const sentDetails = () =>
  (mockCreateNotification.mock.calls[0][0] as { details: Record<string, unknown> }).details;

beforeEach(() => {
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
});

describe('notifyAppBlockSubmitter', () => {
  it('forwards a single-user System notification with the type, key and details', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-approved',
        userId: 77,
        key: 'app-block-approved:req_1',
        details: { slug: 'cool-app', name: 'Cool App', version: '1.0.0' },
        attribution: { kind: 'moderator', userId: 31 },
      },
      async () => true
    );

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: 77,
      category: 'System',
      type: 'app-block-approved',
      key: 'app-block-approved:req_1',
      details: { slug: 'cool-app', name: 'Cool App', version: '1.0.0', reviewerUserId: 31 },
    });
  });

  it('records an automated decision as automated, with no reviewer id', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 5,
        key: 'app-block-rejected:req_3',
        details: { slug: 's', reason: 'nope' },
        attribution: { kind: 'automated' },
      },
      async () => true
    );
    expect(sentDetails()).toEqual({ slug: 's', reason: 'nope', reviewedAutomatically: true });
  });

  it('carries the rejection reason through in details, and never asks about run pages', async () => {
    const canOpen = vi.fn(async (_userId: number) => true);
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 5,
        key: 'app-block-rejected:req_2',
        details: { slug: 's', reason: 'nope' },
        attribution: { kind: 'moderator', userId: 31 },
      },
      canOpen
    );
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg.type).toBe('app-block-rejected');
    expect(arg.details.reason).toBe('nope');
    expect(sentDetails()).not.toHaveProperty('canOpenRunPage');
    expect(canOpen).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    '🔴 an approval records canOpenRunPage=%s, asked of the SUBMITTER',
    async (answer) => {
      const canOpen = vi.fn(async (_userId: number) => answer);
      await notifyAppBlockSubmitter(
        {
          type: 'app-block-approved',
          userId: 77,
          key: 'app-block-approved:req_1',
          details: { slug: 'cool-app', hasPage: true },
          attribution: { kind: 'moderator', userId: 31 },
        },
        canOpen
      );
      expect(canOpen.mock.calls).toEqual([[77]]);
      expect(sentDetails()).toEqual({
        slug: 'cool-app',
        hasPage: true,
        reviewerUserId: 31,
        canOpenRunPage: answer,
      });
    }
  );

  it('🔴 a failed run-page read still sends the approval, with canOpenRunPage false', async () => {
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-approved',
        userId: 77,
        key: 'app-block-approved:req_1',
        details: { slug: 'cool-app', hasPage: true },
        attribution: { kind: 'moderator', userId: 31 },
      },
      async () => Promise.reject(new Error('flags unreadable'))
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(sentDetails().canOpenRunPage).toBe(false);
  });
});
