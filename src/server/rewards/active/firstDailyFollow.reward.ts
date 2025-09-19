import { createBuzzEvent } from '../base.reward';

export const firstDailyFollowReward = createBuzzEvent({
  type: 'firstDailyFollow',
  toAccountType: 'blue',
  description: 'For first 3 people that you follow each day',
  tooltip: 'If you unfollow and follow the same person, you will not get this reward again.',
  awardAmount: 10,
  cap: 30,
  onDemand: true,
  getKey: async (input: FollowEvent) => {
    return {
      toUserId: input.userId,
      forId: input.followingId,
      byUserId: input.userId,
      type: `firstDailyFollow`,
    };
  },
});

type FollowEvent = {
  userId: number;
  followingId: number;
};
