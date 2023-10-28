import { createBuzzEvent } from '../base.reward';

export const firstDailyFollowReward = createBuzzEvent({
  type: 'firstDailyFollow',
  description: 'For the first person that you follow each day',
  awardAmount: 10,
  cap: 10,
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
