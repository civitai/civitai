import { describe, expect, it, vi } from 'vitest';

const { createNotification } = vi.hoisted(() => ({ createNotification: vi.fn() }));

vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));

const { notifyAppealResolved } = await import('../image-moderation-effects');

describe('notifyAppealResolved', () => {
  // An image can be appealed again after a re-block. The notification service reuses the row for a
  // repeated key, so a per-image key would show the second decision as the first one.
  it('keys the notification by appeal, not only by image', async () => {
    await notifyAppealResolved({
      appeal: { id: 555, userId: 1 },
      entityId: 128489949,
      status: 'Rejected',
    });

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, key: 'entity-appeal-resolved:Image:128489949:555' })
    );
  });

  it('keeps an image appeal’s details as they were', async () => {
    createNotification.mockClear();
    await notifyAppealResolved({ appeal: { id: 3, userId: 8 }, entityId: 40, status: 'Approved' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { entityType: 'Image', entityId: 40, status: 'Approved', resolvedMessage: '' },
      })
    );
  });

  // The main app's `entity-appeal-resolved` copy reads a site appeal's `category` and `restored`.
  it('names a site appeal by its own entity and carries its category', async () => {
    createNotification.mockClear();
    await notifyAppealResolved({
      appeal: { id: 4, userId: 8 },
      entityType: 'User',
      entityId: 8,
      status: 'Rejected',
      resolvedMessage: 'No.',
      details: { category: 'Account', restored: false },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 8,
        key: 'entity-appeal-resolved:User:8:4',
        details: {
          category: 'Account',
          restored: false,
          entityType: 'User',
          entityId: 8,
          status: 'Rejected',
          resolvedMessage: 'No.',
        },
      })
    );
  });
});
