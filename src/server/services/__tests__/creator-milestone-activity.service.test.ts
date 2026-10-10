import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));

import type * as NotificationService from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';
import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import { notifyMilestonesReached } from '~/server/services/creator-milestone-activity.service';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';

beforeEach(() => vi.clearAllMocks());

const grant = (userId: number, milestoneKey: string, name: string) => ({
  userId,
  milestoneKey,
  name,
  threshold: 1,
  silent: false,
});

describe('notifyMilestonesReached', () => {
  it('sends one Milestone notification per grant, keyed so two milestones on one night both arrive', async () => {
    await notifyMilestonesReached([
      grant(1, 'create:models-1', 'First Model'),
      grant(1, 'create:articles-1', 'First Article'),
      grant(2, 'create:models-1', 'First Model'),
    ]);
    const sent = mocks.createNotification.mock.calls.map(([row]) => row as Record<string, unknown>);
    expect(sent.map((row) => row.key).sort()).toEqual([
      'creator-milestone-reached:1:create:articles-1',
      'creator-milestone-reached:1:create:models-1',
      'creator-milestone-reached:2:create:models-1',
    ]);
    for (const row of sent) {
      expect(row).toMatchObject({
        type: 'creator-milestone-reached',
        category: NotificationCategory.Milestone,
      });
    }
    expect(
      sent.find((row) => row.key === 'creator-milestone-reached:2:create:models-1')
    ).toMatchObject({
      userId: 2,
      details: { milestoneKey: 'create:models-1', name: 'First Model' },
    });
  });

  it('renders through the registered processor, naming the milestone and linking to the journey', async () => {
    await notifyMilestonesReached([grant(1, 'reach:followers-100', '100 Followers')]);
    const [[row]] = mocks.createNotification.mock.calls as unknown as [[Record<string, unknown>]];
    expect(getNotificationMessage(row as never)).toEqual({
      message: 'Milestone unlocked: 100 Followers. See it on your Creator Journey.',
      url: CREATOR_JOURNEY_HREF,
    });
  });
});
