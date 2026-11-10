import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';

const createNotification = vi.hoisted(() => vi.fn(async (_n: unknown) => undefined));

vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));

const { sendModNotification } = await import('../moderation-memory.service');

beforeEach(() => vi.clearAllMocks());

describe('a moderator notification', () => {
  it('is never sent to the feedback capture account', async () => {
    expect(
      await sendModNotification({ userId: FEEDBACK_CAPTURE_OWNER_ID, message: 'm', moderatorId: 9 })
    ).toEqual({ ok: false, error: expect.stringMatching(/feedback page captures/) });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('is sent to an ordinary account', async () => {
    expect(await sendModNotification({ userId: 42, message: 'm', moderatorId: 9 })).toEqual({
      ok: true,
    });
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
