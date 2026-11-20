import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `notifyAppBlockSubmitter` helper — forwards to `createNotification` with the right
 * shape via its dynamic import. Only the notifications client is mocked; the helper's
 * static import is a type (erased), so nothing else is pulled. `~/server/common/enums`
 * is the REAL module (so we assert the actual `NotificationCategory.System` value).
 */

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { notifyAppBlockSubmitter } = await import('~/server/services/blocks/app-block-notify');

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
      details: { slug: 'cool-app', name: 'Cool App', version: '1.0.0' },
    });
  });

  it('carries the rejection reason through in details, and never asks about run pages', async () => {
    const canOpen = vi.fn(async (_userId: number) => true);
    await notifyAppBlockSubmitter(
      {
        type: 'app-block-rejected',
        userId: 5,
        key: 'app-block-rejected:req_2',
        details: { slug: 's', reason: 'nope' },
      },
      canOpen
    );
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg.type).toBe('app-block-rejected');
    expect(arg.details.reason).toBe('nope');
    expect(arg.details).not.toHaveProperty('canOpenRunPage');
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
        },
        canOpen
      );
      expect(canOpen.mock.calls).toEqual([[77]]);
      expect(mockCreateNotification.mock.calls[0][0].details).toEqual({
        slug: 'cool-app',
        hasPage: true,
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
      },
      async () => Promise.reject(new Error('flags unreadable'))
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0].details.canOpenRunPage).toBe(false);
  });
});
