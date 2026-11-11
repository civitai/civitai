import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';

const createNotification = vi.hoisted(() => vi.fn(async (_n: unknown) => undefined));

vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../notifications', () => ({ getNotifications: () => ({ createNotification }) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));

vi.mock('../redis', () => ({ getSysRedis: vi.fn(), getRedis: vi.fn() }));
vi.mock('../clickhouse', () => ({ getClickhouse: vi.fn() }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));

const { sendModNotification } = await import('../moderation-memory.service');
const { notifyImageTosViolation } = await import('../image-moderation-effects');

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

describe('the ToS notice on a block', () => {
  it('is never sent for a feedback page capture', async () => {
    await notifyImageTosViolation({ imageId: 1, ownerId: FEEDBACK_CAPTURE_OWNER_ID, postId: null });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("is sent to an ordinary image's owner (control)", async () => {
    await notifyImageTosViolation({ imageId: 1, ownerId: 42, postId: null });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
  });
});
