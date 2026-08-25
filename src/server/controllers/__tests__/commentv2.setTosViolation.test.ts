import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';

const { mockBulkSetTos } = vi.hoisted(() => ({ mockBulkSetTos: vi.fn() }));

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  bulkSetCommentV2TosViolation: mockBulkSetTos,
}));

import { setTosViolationHandler } from '../commentv2.controller';

const ctx = (over?: { id?: number; ip?: string }) =>
  ({ user: { id: over?.id ?? 5150 }, ip: over?.ip ?? '203.0.113.9' } as never);

describe('commentv2 setTosViolationHandler', () => {
  beforeEach(() => {
    mockBulkSetTos.mockReset();
  });

  it('delegates to the bulk service so reports, rewards and the notification come with it', async () => {
    mockBulkSetTos.mockResolvedValue({ count: 1, notified: 1, rewardedReports: 2 });

    const result = await setTosViolationHandler({ input: { id: 91 }, ctx: ctx() });

    expect(mockBulkSetTos).toHaveBeenCalledTimes(1);
    expect(mockBulkSetTos).toHaveBeenCalledWith({
      ids: [91],
      actor: { id: 5150, ip: '203.0.113.9' },
    });
    expect(result).toEqual({ count: 1, notified: 1, rewardedReports: 2 });
  });

  // count 0 is what the service returns when the id matched nothing — the update is caught
  // per-id and skipped, so without this the caller gets a cheerful "removed 0 comments".
  it('throws NOT_FOUND when the comment does not exist', async () => {
    mockBulkSetTos.mockResolvedValue({ count: 0, notified: 0, rewardedReports: 0 });

    await expect(setTosViolationHandler({ input: { id: 404 }, ctx: ctx() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('acts as the calling moderator, not a shared service identity', async () => {
    mockBulkSetTos.mockResolvedValue({ count: 1, notified: 0, rewardedReports: 0 });

    await setTosViolationHandler({ input: { id: 7 }, ctx: ctx({ id: 88, ip: '198.51.100.4' }) });

    expect(mockBulkSetTos.mock.calls[0][0].actor).toEqual({ id: 88, ip: '198.51.100.4' });
  });
});
