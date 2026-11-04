import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotificationCursor } from '@civitai/notifications';
import type * as NotificationService from '~/server/services/notification.service';

const { mockGetUserNotifications } = vi.hoisted(() => ({ mockGetUserNotifications: vi.fn() }));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  getUserNotifications: mockGetUserNotifications,
}));
vi.mock('~/server/utils/browsing-level', () => ({ getRequestBrowsingLevel: () => 1 }));

import { getUserNotificationsInfiniteHandler } from '../notification.controller';

const row = (id: number) => ({ id, createdAt: new Date(Date.UTC(2026, 10, 4, 3, 0, 0, 100 - id)) });
const ctx = { user: { id: 7 } } as never;

describe('getUserNotificationsInfiniteHandler paging', () => {
  beforeEach(() => mockGetUserNotifications.mockReset());

  it('asks for one row past the page and points the cursor at the last row shown', async () => {
    mockGetUserNotifications.mockResolvedValue({ items: [row(1), row(2), row(3), row(4)] });

    const page = await getUserNotificationsInfiniteHandler({ input: { limit: 3 }, ctx });

    expect(mockGetUserNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4, userId: 7 })
    );
    expect(page.items).toEqual([row(1), row(2), row(3)]);
    expect(parseNotificationCursor(page.nextCursor ?? '')).toEqual(row(3));
  });

  it('has no next cursor on the last page', async () => {
    mockGetUserNotifications.mockResolvedValue({ items: [row(1), row(2)] });

    const page = await getUserNotificationsInfiniteHandler({ input: { limit: 3 }, ctx });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });
});
