import { beforeEach, expect, it, vi } from 'vitest';
import type * as CommentService from '~/server/services/comment.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as Rewards from '~/server/rewards';

// Flagging a legacy comment already hidden for ToS still actions and rewards its reports, but its
// author is not told again.

const { isLegacyCommentHidden, updateReports, createNotification, reward } = vi.hoisted(() => ({
  isLegacyCommentHidden: vi.fn(async (_id: number) => false),
  updateReports: vi.fn(async () => [{ id: 501, userId: 7 }]),
  createNotification: vi.fn(async () => undefined),
  reward: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/comment.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentService>()),
  isLegacyCommentHidden,
  updateCommentById: vi.fn(async ({ id }: { id: number }) => ({
    id,
    user: { id: 9 },
    model: { name: 'm' },
  })),
  updateCommentReportStatusByReason: updateReports,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/rewards', async (importOriginal) => ({
  ...(await importOriginal<typeof Rewards>()),
  reportAcceptedReward: { apply: reward },
}));

import { setTosViolationHandler } from '../comment.controller';

const ctx = { user: { id: 1, isModerator: true }, ip: '203.0.113.9' } as never;

beforeEach(() => vi.clearAllMocks());

it.each([
  ['already hidden', 0, true],
  ['live (control)', 1, false],
])(
  'a comment %s has its reports actioned and rewarded, notifying %i',
  async (_, notices, hidden) => {
    isLegacyCommentHidden.mockResolvedValueOnce(hidden);
    await expect(setTosViolationHandler({ input: { id: 5 }, ctx })).resolves.toMatchObject({
      id: 5,
    });
    expect(updateReports).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }));
    expect(reward).toHaveBeenCalledWith({ userId: 7, reportId: 501 }, { ip: '203.0.113.9' });
    expect(createNotification).toHaveBeenCalledTimes(notices);
  }
);
