import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `notifyAppModeratorMessage` — forwards to `createNotification` with the right shape
 * via its dynamic import. Only the notifications client is mocked; the helper's static
 * import is a type (erased), so nothing else is pulled. `~/server/common/enums` is the
 * REAL module, so the asserted `NotificationCategory.System` is an actual value and not
 * a string this file made up.
 */

const { mockCreateNotification } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { notifyAppModeratorMessage } = await import(
  '~/server/services/blocks/app-moderator-message-notify'
);

const DETAILS = {
  slug: 'prompt-vault',
  listingId: 'apl_live',
  subject: 'A false claim in your listing',
  body: 'It says it asks before it spends. It does not.',
};

beforeEach(() => {
  mockCreateNotification.mockReset().mockResolvedValue(undefined);
});

describe('notifyAppModeratorMessage', () => {
  it('forwards ONE System notification carrying every recipient, the key and the details', async () => {
    await notifyAppModeratorMessage({
      userIds: [42, 77],
      key: 'app-moderator-message:alme_1',
      details: DETAILS,
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const arg = mockCreateNotification.mock.calls[0][0];
    expect(arg).toMatchObject({
      userIds: [42, 77],
      category: 'System',
      type: 'app-moderator-message',
      key: 'app-moderator-message:alme_1',
      details: DETAILS,
    });
  });

  it('🔴 uses `userIds`, not a per-recipient call', async () => {
    // `PendingNotification.key` is UNIQUE and a repeat emit MERGES recipients into the
    // existing row, so N calls sharing one key produce one notification with N users
    // anyway — but only after N round trips, and a partial failure would deliver to the
    // owner and not the editors. One call is the substrate's own fan-out.
    await notifyAppModeratorMessage({
      userIds: [42, 77, 13],
      key: 'app-moderator-message:alme_2',
      details: DETAILS,
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('🔴 an EMPTY recipient list emits NOTHING', async () => {
    // A zero-recipient emit would create a PendingNotification nobody can receive AND
    // burn the key, so a genuine later delivery under the same key would be merged into
    // the dead row instead of being sent — i.e. it fails silently and permanently.
    await notifyAppModeratorMessage({
      userIds: [],
      key: 'app-moderator-message:alme_3',
      details: DETAILS,
    });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
