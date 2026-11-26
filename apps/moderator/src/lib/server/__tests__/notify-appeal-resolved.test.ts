import { NsfwLevel } from '@civitai/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createNotification, execute } = vi.hoisted(() => ({
  createNotification: vi.fn(),
  execute: vi.fn(),
}));
const query = { select: () => query, where: () => query, execute };

vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('$lib/server/db', () => ({ dbRead: { selectFrom: () => query }, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../civitai-url', () => ({
  civitaiAppUrl: () => 'https://com.test',
  civitaiLinkUrl: () => 'https://red.test',
}));

const { notifyAppealResolved } = await import('../image-moderation-effects');

describe('notifyAppealResolved', () => {
  beforeEach(() => {
    createNotification.mockClear();
    execute.mockReset();
    execute.mockResolvedValue([{ id: 40, nsfwLevel: NsfwLevel.PG }]);
  });
  const sentDetails = () => createNotification.mock.calls[0][0].details;
  // An image can be appealed again after a re-block. The notification service reuses the row for a
  // repeated key, so a per-image key would show the second decision as the first one.
  it('keys the notification by appeal, not only by image', async () => {
    await notifyAppealResolved({
      appeal: { id: 555, userId: 1 },
      entityId: 990100036,
      status: 'Rejected',
    });

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, key: 'entity-appeal-resolved:Image:990100036:555' })
    );
  });

  it('files the decision under the Moderation tab', async () => {
    createNotification.mockClear();
    await notifyAppealResolved({ appeal: { id: 3, userId: 8 }, entityId: 40, status: 'Approved' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Moderation' })
    );
  });

  it('keeps a PG image appeal’s details as they were, so the bell opens it on its own host', async () => {
    createNotification.mockClear();
    await notifyAppealResolved({ appeal: { id: 3, userId: 8 }, entityId: 40, status: 'Approved' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { entityType: 'Image', entityId: 40, status: 'Approved', resolvedMessage: '' },
      })
    );
  });

  // civitai.com does not serve a mature image; the bell would open a relative path there.
  it('links a mature image’s result to civitai.red', async () => {
    execute.mockResolvedValue([{ id: 41, nsfwLevel: NsfwLevel.X }]);
    await notifyAppealResolved({ appeal: { id: 3, userId: 8 }, entityId: 41, status: 'Rejected' });
    expect(sentDetails().url).toBe('https://red.test/images/41');
  });

  it('links to civitai.red, and still notifies, when the rating read fails', async () => {
    execute.mockRejectedValue(new Error('read failed'));
    await notifyAppealResolved({ appeal: { id: 3, userId: 8 }, entityId: 40, status: 'Approved' });
    expect(sentDetails().url).toBe('https://red.test/images/40');
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
