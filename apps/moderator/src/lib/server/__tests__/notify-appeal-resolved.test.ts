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
});
