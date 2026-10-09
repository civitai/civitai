import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));

import type * as NotificationService from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';
import { getNotificationMessage } from '~/server/notifications/utils.notifications';
import {
  getScoreTierNotificationDetails,
  grantScoreTierMilestones,
  notifyScoreTierCrossings,
  unlocksAtTier,
} from '~/server/services/creator-milestone-grant.service';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';

const unlocks = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);

beforeEach(() => vi.clearAllMocks());

describe('grantScoreTierMilestones', () => {
  it('skips the query when no score moved', async () => {
    const cancellableQuery = vi.fn();
    expect(await grantScoreTierMilestones({ cancellableQuery } as never, [])).toEqual([]);
    expect(cancellableQuery).not.toHaveBeenCalled();
  });
});

describe('unlocksAtTier', () => {
  it('names the privileges that sit on the tier threshold', () => {
    expect(unlocksAtTier(unlocks, 500)).toContain('Judge crucibles');
    expect(unlocksAtTier(unlocks, 5000)).toContain('Create challenges and crucibles');
    expect(unlocksAtTier(unlocks, 40000)).toContain('Join the Creator Program');
  });

  it('names the daily article limit on the tier its threshold sits on', () => {
    expect(unlocksAtTier(unlocks, 1000)).toContain('Publish up to 5 articles a day');
  });

  it('names nothing for a prestige tier with no gate on it', () => {
    expect(unlocksAtTier(unlocks, 1_000_000)).toEqual([]);
  });

  it('never names the next rung up when nothing sits on the tier itself', () => {
    const above = { ...unlocks[0], key: 'above', label: 'Above', minScore: 2_000_000 };
    expect(unlocksAtTier([above], 1_000_000)).toEqual([]);
  });
});

describe('creator-score-tier-reached notification', () => {
  it('names the tier, its score and what it unlocked', () => {
    const details = getScoreTierNotificationDetails(
      { userId: 1, milestoneKey: 'score:spark', name: 'Spark', threshold: 500 },
      unlocks
    );
    const message = getNotificationMessage({
      type: 'creator-score-tier-reached',
      details,
    } as never);
    expect(message?.message).toMatch(/^You reached Spark, a Creator Score of 500\. Unlocked: /);
    expect(message?.message).toContain('Judge crucibles');
    expect(message?.url).toBe('/user/account#creator-score');
  });

  // Each named slot is spent in registry order, so another gate at 5,000 can crowd this one out.
  it('still names challenge creation within the capped unlocks at 5,000', () => {
    const details = getScoreTierNotificationDetails(
      { userId: 1, milestoneKey: 'score:flame', name: 'Flame', threshold: 5000 },
      unlocks
    );
    expect(details.unlocks).toContain('Create challenges and crucibles');
  });

  it('caps the named unlocks and counts the rest', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((label) => ({
      ...unlocks[0],
      key: label,
      label,
      minScore: 10000,
    }));
    expect(
      getScoreTierNotificationDetails(
        { userId: 1, milestoneKey: 'score:blaze', name: 'Blaze', threshold: 10000 },
        many
      )
    ).toMatchObject({ unlocks: ['a', 'b', 'c'], moreUnlocks: 2 });
  });

  it('formats a capped list with its remainder', () => {
    const message = getNotificationMessage({
      type: 'creator-score-tier-reached',
      details: {
        tierName: 'Blaze',
        threshold: 10000,
        unlocks: ['a', 'b', 'c'],
        moreUnlocks: 4,
      },
    } as never);
    expect(message?.message).toBe(
      'You reached Blaze, a Creator Score of 10,000. Unlocked: a; b; c, and 4 more.'
    );
  });

  it('omits the unlocked clause for a prestige tier', () => {
    const message = getNotificationMessage({
      type: 'creator-score-tier-reached',
      details: { tierName: 'Legend', threshold: 10_000_000, unlocks: [], moreUnlocks: 0 },
    } as never);
    expect(message?.message).toBe('You reached Legend, a Creator Score of 10,000,000.');
  });
});

describe('notifyScoreTierCrossings', () => {
  it('sends one Milestone notification per crossing, keyed to the user and tier', async () => {
    await notifyScoreTierCrossings(
      [
        { userId: 1, milestoneKey: 'score:spark', name: 'Spark', threshold: 500 },
        { userId: 1, milestoneKey: 'score:kindle', name: 'Kindle', threshold: 1000 },
        { userId: 2, milestoneKey: 'score:spark', name: 'Spark', threshold: 500 },
      ],
      unlocks
    );
    const sent = mocks.createNotification.mock.calls.map(([row]) => row as Record<string, unknown>);
    expect(sent.map((row) => row.key).sort()).toEqual([
      'creator-score-tier-reached:1:score:kindle',
      'creator-score-tier-reached:1:score:spark',
      'creator-score-tier-reached:2:score:spark',
    ]);
    for (const row of sent) {
      expect(row.type).toBe('creator-score-tier-reached');
      expect(row.category).toBe(NotificationCategory.Milestone);
    }
    expect(sent.find((row) => row.key === 'creator-score-tier-reached:2:score:spark')?.userId).toBe(
      2
    );
  });
});
